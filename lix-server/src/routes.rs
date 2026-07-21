use crate::{WorkspaceRuntimeError, WorkspaceRuntimeManager};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use serde_json::json;
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tower::ServiceExt;
use tracing::Instrument as _;

#[derive(Clone)]
struct AppState {
    manager: Arc<WorkspaceRuntimeManager>,
    internal_token: Option<Arc<str>>,
    protocol_timeout: Duration,
}

struct TracedBody {
    inner: Body,
    span: tracing::Span,
}

impl http_body::Body for TracedBody {
    type Data = <Body as http_body::Body>::Data;
    type Error = <Body as http_body::Body>::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let span = self.span.clone();
        let _entered = span.enter();
        Pin::new(&mut self.inner).poll_frame(context)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

pub fn router(
    manager: Arc<WorkspaceRuntimeManager>,
    internal_token: Option<String>,
    protocol_timeout: Duration,
) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/workspaces/{workspace_id}/{*protocol_path}",
            any(workspace_protocol),
        )
        .with_state(AppState {
            manager,
            internal_token: internal_token.map(Arc::from),
            protocol_timeout,
        })
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "service": "lix-server"}))
}

async fn workspace_protocol(
    State(state): State<AppState>,
    Path((workspace_id, protocol_path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    let span = tracing::info_span!(
        "lix.protocol.request",
        "otel.name" = "Lix protocol request",
        "otel.kind" = "server",
        "http.request.method" = %request.method(),
        "http.route" = "/workspaces/{workspace_id}/{*protocol_path}",
        "lix.workspace.id" = %workspace_id,
        "lix.protocol.path" = %protocol_path,
        "http.response.status_code" = tracing::field::Empty,
    );
    let response = workspace_protocol_inner(state, workspace_id, protocol_path, request)
        .instrument(span.clone())
        .await;
    span.record("http.response.status_code", response.status().as_u16());
    let (parts, body) = response.into_parts();
    Response::from_parts(parts, Body::new(TracedBody { inner: body, span }))
}

async fn workspace_protocol_inner(
    state: AppState,
    workspace_id: String,
    protocol_path: String,
    mut request: Request<Body>,
) -> Response {
    if !authorized(request.headers(), state.internal_token.as_deref()) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            Json(json!({"error": "invalid internal service token"})),
        )
            .into_response();
    }

    // The open path gets the same deadline as the protocol call: a wedged
    // store can hang the runtime open before anything is logged, and every
    // caller for that workspace then queues behind it.
    let runtime = match tokio::time::timeout(
        state.protocol_timeout,
        state.manager.get(&workspace_id),
    )
    .await
    {
        Ok(Ok(runtime)) => runtime,
        Ok(Err(error)) => return workspace_error(error),
        Err(_elapsed) => {
            tracing::warn!(
                workspace_id,
                timeout_secs = state.protocol_timeout.as_secs(),
                "workspace open exceeded its deadline; abandoning pending open"
            );
            state.manager.abandon_uninitialized(&workspace_id).await;
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error": "workspace open timed out"})),
            )
                .into_response();
        }
    };

    let path_and_query = match request.uri().query() {
        Some(query) => format!("/{protocol_path}?{query}"),
        None => format!("/{protocol_path}"),
    };
    let Ok(uri) = path_and_query.parse::<Uri>() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid protocol path"})),
        )
            .into_response();
    };
    *request.uri_mut() = uri;

    // A deadline on the whole protocol call: the object-store client has its
    // own request budget, but a wedged connection (e.g. after a host sleep)
    // can still hang past it — without this bound the request never answers
    // and the runtime stays wedged for every caller after it.
    let handler_future = lix_server_protocol::handler(runtime.protocol_lix()).oneshot(request);
    let response = match tokio::time::timeout(state.protocol_timeout, handler_future).await {
        Ok(response) => response.expect("canonical Lix protocol router is infallible"),
        Err(_elapsed) => {
            tracing::warn!(
                workspace_id,
                timeout_secs = state.protocol_timeout.as_secs(),
                "protocol request exceeded its deadline; recovering runtime"
            );
            state.manager.recover(&workspace_id, &runtime).await;
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error": "workspace request timed out"})),
            )
                .into_response();
        }
    };
    if runtime.has_terminal_durability_failure() {
        state.manager.recover(&workspace_id, &runtime).await;
        return workspace_error(WorkspaceRuntimeError::Recovering);
    }
    response
}

fn authorized(headers: &HeaderMap, internal_token: Option<&str>) -> bool {
    let Some(internal_token) = internal_token else {
        return true;
    };
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == internal_token)
}

fn workspace_error(error: WorkspaceRuntimeError) -> Response {
    let status = match error {
        WorkspaceRuntimeError::InvalidId => StatusCode::BAD_REQUEST,
        WorkspaceRuntimeError::AtCapacity { .. }
        | WorkspaceRuntimeError::Recovering
        | WorkspaceRuntimeError::Open(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(json!({"error": error.to_string()}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::http::Request;
    use futures_util::stream::BoxStream;
    use http_body_util::BodyExt;
    use object_store::memory::InMemory;
    use object_store::path::Path as ObjectPath;
    use object_store::{
        CopyOptions, Error as ObjectStoreError, GetOptions as ObjectStoreGetOptions, GetResult,
        ListResult, MultipartUpload, ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions,
        PutPayload, PutResult, RenameOptions, Result as ObjectStoreResult,
    };
    use serde_json::{json, Value as JsonValue};
    use std::{
        ops::Range,
        sync::{
            atomic::{AtomicBool, Ordering},
            Condvar, Mutex,
        },
        time::{Duration, Instant},
    };
    use tokio::task::JoinSet;

    const TEST_PROTOCOL_TIMEOUT: Duration = Duration::from_secs(60);

    fn test_router() -> Router {
        let manager = WorkspaceRuntimeManager::new_in_memory(4);
        router(manager, None, TEST_PROTOCOL_TIMEOUT)
    }

    async fn json_body(response: Response) -> JsonValue {
        serde_json::from_slice(
            &response
                .into_body()
                .collect()
                .await
                .expect("response body")
                .to_bytes(),
        )
        .expect("response JSON")
    }

    #[tokio::test]
    async fn exposes_only_the_workspace_addressed_protocol() {
        let app = test_router();
        let unscoped = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/lix/v1/")
                    .body(Body::empty())
                    .expect("unscoped request"),
            )
            .await
            .expect("unscoped response");
        assert_eq!(unscoped.status(), StatusCode::NOT_FOUND);

        let handshake = app
            .oneshot(
                Request::builder()
                    .uri("/workspaces/workspace-a/lix/v1/")
                    .body(Body::empty())
                    .expect("handshake request"),
            )
            .await
            .expect("handshake response");
        assert_eq!(handshake.status(), StatusCode::OK);
        assert_eq!(json_body(handshake).await["protocolVersion"], json!(1));
    }

    #[tokio::test]
    async fn health_does_not_open_a_workspace_or_require_authentication() {
        let response = test_router()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["service"], "lix-server");
    }

    #[tokio::test]
    async fn internal_token_protects_workspace_routes() {
        let manager = WorkspaceRuntimeManager::new_in_memory(4);
        let app = router(manager, Some("secret".to_string()), TEST_PROTOCOL_TIMEOUT);

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/workspaces/workspace-a/lix/v1/")
                    .body(Body::empty())
                    .expect("unauthorized request"),
            )
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let authorized = app
            .oneshot(
                Request::builder()
                    .uri("/workspaces/workspace-a/lix/v1/")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("authorized request"),
            )
            .await
            .expect("authorized response");
        assert_eq!(authorized.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn isolates_workspace_data() {
        let app = test_router();
        let insert = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/workspaces/workspace-a/lix/v1/execute")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sql":"INSERT INTO lix_file (path, data) VALUES ('/only-a.txt', X'41')"}"#,
                    ))
                    .expect("insert request"),
            )
            .await
            .expect("insert response");
        assert_eq!(
            insert.status(),
            StatusCode::OK,
            "{:?}",
            json_body(insert).await
        );

        for (workspace_id, expected) in [("workspace-a", 1), ("workspace-b", 0)] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!(
                            "/workspaces/{workspace_id}/lix/v1/execute"
                        ))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"sql":"SELECT COUNT(*) AS count FROM lix_file WHERE path = '/only-a.txt'"}"#,
                        ))
                        .expect("count request"),
                )
                .await
                .expect("count response");
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(json_body(response).await["rows"][0][0]["value"], expected);
        }
    }

    #[tokio::test]
    async fn rejects_unsafe_workspace_ids() {
        let response = test_router()
            .oneshot(
                Request::builder()
                    .uri("/workspaces/contains%20space/lix/v1/")
                    .body(Body::empty())
                    .expect("unsafe request"),
            )
            .await
            .expect("unsafe response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn poisoned_runtime_fault_injection_recovers_after_draining_old_service() {
        const QUEUED_REQUESTS: usize = 8;
        let inner = Arc::new(InMemory::new());
        let store = Arc::new(BlockingStore::new(Arc::clone(&inner)));
        let manager = WorkspaceRuntimeManager::new_with_test_object_store(4, store.clone());
        let app = router(Arc::clone(&manager), None, TEST_PROTOCOL_TIMEOUT);
        let workspace_id = "poisoned-workspace";

        let opened = protocol_request(
            app.clone(),
            workspace_id,
            "SELECT COUNT(*) AS count FROM lix_file",
        )
        .await;
        assert_eq!(opened.status(), StatusCode::OK);
        let recovery_lease = manager
            .get(workspace_id)
            .await
            .expect("open initial workspace runtime");
        let original_ptr = Arc::as_ptr(&recovery_lease);

        store.fail_writes();
        let blocked_write = store.block_next_write();
        let failed_write_started = Instant::now();
        let failed_write = tokio::spawn(protocol_request(
            app.clone(),
            workspace_id,
            "INSERT INTO lix_file (path, data) VALUES ('/not-durable.txt', X'41')",
        ));
        blocked_write
            .wait_for_entries(1, "post-open SlateDB WAL write")
            .await;

        let mut queued = JoinSet::new();
        for _ in 0..QUEUED_REQUESTS {
            queued.spawn(protocol_request(
                app.clone(),
                workspace_id,
                "SELECT COUNT(*) AS count FROM lix_file",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            queued.try_join_next().is_none(),
            "requests should still be queued behind the pending WAL flush"
        );

        drop(blocked_write);
        let failed_write = failed_write.await.expect("join failed write request");
        let time_to_503 = failed_write_started.elapsed();
        assert_eq!(failed_write.status(), StatusCode::SERVICE_UNAVAILABLE);

        let mut queued_statuses = Vec::with_capacity(QUEUED_REQUESTS);
        while let Some(response) = queued.join_next().await {
            queued_statuses.push(response.expect("join queued request").status());
        }
        assert_eq!(queued_statuses.len(), QUEUED_REQUESTS);
        assert!(
            queued_statuses
                .iter()
                .all(|status| *status == StatusCode::SERVICE_UNAVAILABLE),
            "recovery should turn every queued request into a bounded 503: {queued_statuses:?}"
        );

        assert!(matches!(
            manager.get(workspace_id).await,
            Err(WorkspaceRuntimeError::Recovering)
        ));
        let stale_probe = protocol_request(
            app.clone(),
            workspace_id,
            "SELECT COUNT(*) AS count FROM lix_file",
        )
        .await;
        assert_eq!(
            stale_probe.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "new requests must receive 503 until the old service drains"
        );

        store.allow_writes();
        let recovery_released = Instant::now();
        drop(recovery_lease);
        let reopened = wait_for_reopened_runtime(&manager, workspace_id).await;
        let recovery_reopen_latency = recovery_released.elapsed();
        assert_ne!(Arc::as_ptr(&reopened), original_ptr);
        let (left, right) = tokio::join!(manager.get(workspace_id), manager.get(workspace_id));
        let left = left.expect("reuse fresh runtime on left request");
        let right = right.expect("reuse fresh runtime on right request");
        assert!(Arc::ptr_eq(&reopened, &left));
        assert!(Arc::ptr_eq(&left, &right));

        let durable_state = protocol_request(
            app,
            workspace_id,
            "SELECT COUNT(*) AS count FROM lix_file WHERE path = '/not-durable.txt'",
        )
        .await;
        assert_eq!(durable_state.status(), StatusCode::OK);
        assert_eq!(json_body(durable_state).await["rows"][0][0]["value"], 0);

        eprintln!(
            "poisoned-runtime recovery: time_to_503_ms={} queued_503={} cleanup_reopen_ms={} durable_rows=0",
            time_to_503.as_millis(),
            QUEUED_REQUESTS,
            recovery_reopen_latency.as_millis(),
        );
    }

    #[tokio::test]
    async fn wedged_protocol_request_times_out_and_recovers() {
        let inner = Arc::new(InMemory::new());
        let store = Arc::new(BlockingStore::new(Arc::clone(&inner)));
        let manager = WorkspaceRuntimeManager::new_with_test_object_store(4, store.clone());
        let app = router(Arc::clone(&manager), None, Duration::from_millis(250));
        let workspace_id = "wedged-workspace";

        let opened = protocol_request(
            app.clone(),
            workspace_id,
            "SELECT COUNT(*) AS count FROM lix_file",
        )
        .await;
        assert_eq!(opened.status(), StatusCode::OK);

        let blocked_write = store.block_next_write();
        let wedged_started = Instant::now();
        let wedged = protocol_request(
            app.clone(),
            workspace_id,
            "INSERT INTO lix_file (path, data) VALUES ('/wedged.txt', X'41')",
        )
        .await;
        assert_eq!(wedged.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(
            wedged_started.elapsed() < Duration::from_secs(5),
            "the deadline must bound the request instead of the store's hang"
        );
        assert_eq!(
            json_body(wedged).await["error"],
            "workspace request timed out"
        );

        // Unblock the store; the recovered runtime reopens for new requests.
        drop(blocked_write);
        let reopened = wait_for_reopened_runtime(&manager, workspace_id).await;
        drop(reopened);
        let after =
            protocol_request(app, workspace_id, "SELECT COUNT(*) AS count FROM lix_file").await;
        assert_eq!(after.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn wedged_workspace_open_times_out_and_allows_retry() {
        let inner = Arc::new(InMemory::new());
        let store = Arc::new(BlockingStore::new(Arc::clone(&inner)));
        let manager = WorkspaceRuntimeManager::new_with_test_object_store(4, store.clone());
        let app = router(Arc::clone(&manager), None, Duration::from_millis(250));
        let workspace_id = "never-opened-workspace";

        // Wedge the store before the workspace has ever opened: the open
        // itself hangs, before any runtime exists to recover.
        let blocked_write = store.block_next_write();
        let wedged_started = Instant::now();
        let wedged = protocol_request(
            app.clone(),
            workspace_id,
            "SELECT COUNT(*) AS count FROM lix_file",
        )
        .await;
        assert_eq!(wedged.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(
            wedged_started.elapsed() < Duration::from_secs(5),
            "the deadline must bound the open instead of the store's hang"
        );
        assert_eq!(json_body(wedged).await["error"], "workspace open timed out");

        // With the store healthy again, a retry gets a fresh open — the
        // abandoned pending open must not leave the workspace stuck.
        drop(blocked_write);
        let retried =
            protocol_request(app, workspace_id, "SELECT COUNT(*) AS count FROM lix_file").await;
        assert_eq!(retried.status(), StatusCode::OK);
    }

    async fn protocol_request(app: Router, workspace_id: &str, sql: &str) -> Response {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/workspaces/{workspace_id}/lix/v1/execute"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "sql": sql }).to_string()))
                .expect("protocol request"),
        )
        .await
        .expect("protocol response")
    }

    async fn wait_for_reopened_runtime(
        manager: &Arc<WorkspaceRuntimeManager>,
        workspace_id: &str,
    ) -> Arc<crate::LixService> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match manager.get(workspace_id).await {
                Ok(runtime) => return runtime,
                Err(WorkspaceRuntimeError::Recovering) => {
                    assert!(
                        Instant::now() < deadline,
                        "workspace runtime did not finish recovery"
                    );
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Err(error) => panic!("unexpected workspace recovery error: {error}"),
            }
        }
    }

    #[derive(Clone, Debug)]
    struct BlockingStore {
        inner: Arc<InMemory>,
        next_write: Arc<AtomicBool>,
        fail_writes: Arc<AtomicBool>,
        writes: Arc<OperationBlock>,
    }

    impl BlockingStore {
        fn new(inner: Arc<InMemory>) -> Self {
            Self {
                inner,
                next_write: Arc::new(AtomicBool::new(false)),
                fail_writes: Arc::new(AtomicBool::new(false)),
                writes: Arc::new(OperationBlock::default()),
            }
        }

        fn block_next_write(&self) -> OperationBlockGuard {
            OperationBlockGuard::arm(Arc::clone(&self.next_write), Arc::clone(&self.writes))
        }

        fn fail_writes(&self) {
            self.fail_writes.store(true, Ordering::Release);
        }

        fn allow_writes(&self) {
            self.fail_writes.store(false, Ordering::Release);
        }

        fn maybe_block_write(&self) {
            if self.next_write.swap(false, Ordering::AcqRel) {
                self.writes.enter();
            }
        }

        fn maybe_fail_write(&self) -> ObjectStoreResult<()> {
            if self.fail_writes.load(Ordering::Acquire) {
                Err(ObjectStoreError::NotSupported {
                    source: Box::new(std::io::Error::other("injected WAL write failure")),
                })
            } else {
                Ok(())
            }
        }
    }

    impl std::fmt::Display for BlockingStore {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("BlockingStore")
        }
    }

    #[derive(Debug, Default)]
    struct OperationBlock {
        state: Mutex<OperationBlockState>,
        available: Condvar,
    }

    #[derive(Debug, Default)]
    struct OperationBlockState {
        entries: usize,
        released: bool,
    }

    impl OperationBlock {
        fn reset(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.entries = 0;
            state.released = false;
        }

        fn enter(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.entries += 1;
            self.available.notify_all();
            while !state.released {
                state = self
                    .available
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        }

        fn release(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.released = true;
            self.available.notify_all();
        }
    }

    #[derive(Debug)]
    struct OperationBlockGuard {
        enabled: Arc<AtomicBool>,
        block: Arc<OperationBlock>,
    }

    impl OperationBlockGuard {
        fn arm(enabled: Arc<AtomicBool>, block: Arc<OperationBlock>) -> Self {
            block.reset();
            enabled.store(true, Ordering::Release);
            Self { enabled, block }
        }

        async fn wait_for_entries(&self, expected: usize, description: &str) {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let entries = {
                    let state = self
                        .block
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.entries
                };
                if entries >= expected {
                    return;
                }
                let now = Instant::now();
                assert!(now < deadline, "timed out waiting for {description}");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }

    impl Drop for OperationBlockGuard {
        fn drop(&mut self) {
            self.enabled.store(false, Ordering::Release);
            self.block.release();
        }
    }

    #[async_trait]
    impl ObjectStore for BlockingStore {
        async fn put_opts(
            &self,
            location: &ObjectPath,
            payload: PutPayload,
            options: PutOptions,
        ) -> ObjectStoreResult<PutResult> {
            self.maybe_block_write();
            self.maybe_fail_write()?;
            self.inner.put_opts(location, payload, options).await
        }

        async fn put_multipart_opts(
            &self,
            location: &ObjectPath,
            options: PutMultipartOptions,
        ) -> ObjectStoreResult<Box<dyn MultipartUpload>> {
            self.inner.put_multipart_opts(location, options).await
        }

        async fn get_opts(
            &self,
            location: &ObjectPath,
            options: ObjectStoreGetOptions,
        ) -> ObjectStoreResult<GetResult> {
            self.inner.get_opts(location, options).await
        }

        async fn get_ranges(
            &self,
            location: &ObjectPath,
            ranges: &[Range<u64>],
        ) -> ObjectStoreResult<Vec<bytes::Bytes>> {
            self.inner.get_ranges(location, ranges).await
        }

        fn delete_stream(
            &self,
            locations: BoxStream<'static, ObjectStoreResult<ObjectPath>>,
        ) -> BoxStream<'static, ObjectStoreResult<ObjectPath>> {
            self.inner.delete_stream(locations)
        }

        fn list(
            &self,
            prefix: Option<&ObjectPath>,
        ) -> BoxStream<'static, ObjectStoreResult<ObjectMeta>> {
            self.inner.list(prefix)
        }

        fn list_with_offset(
            &self,
            prefix: Option<&ObjectPath>,
            offset: &ObjectPath,
        ) -> BoxStream<'static, ObjectStoreResult<ObjectMeta>> {
            self.inner.list_with_offset(prefix, offset)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&ObjectPath>,
        ) -> ObjectStoreResult<ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }

        async fn copy_opts(
            &self,
            from: &ObjectPath,
            to: &ObjectPath,
            options: CopyOptions,
        ) -> ObjectStoreResult<()> {
            self.inner.copy_opts(from, to, options).await
        }

        async fn rename_opts(
            &self,
            from: &ObjectPath,
            to: &ObjectPath,
            options: RenameOptions,
        ) -> ObjectStoreResult<()> {
            self.inner.rename_opts(from, to, options).await
        }
    }
}
