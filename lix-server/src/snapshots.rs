use crate::store::{LixRuntimeError, SnapshotRestoreError};
use crate::LixRuntimeManager;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{stream, StreamExt as _};
use serde_json::json;
use std::{io, sync::Arc};
use tokio::{io::DuplexStream, sync::oneshot};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt as _, TokioAsyncWriteCompatExt as _},
    io::{ReaderStream, StreamReader},
};

const SNAPSHOT_MEDIA_TYPE: &str = "application/vnd.lix.snapshot";
const SNAPSHOT_STREAM_BUFFER_BYTES: usize = 64 * 1024;
const SNAPSHOT_UPLOAD_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Clone)]
struct SnapshotState {
    manager: Arc<LixRuntimeManager>,
    token: Arc<str>,
}

pub(crate) fn router(manager: Arc<LixRuntimeManager>, token: String) -> Router {
    Router::new()
        .route(
            "/_ops/lixes/{lix_id}/snapshot",
            get(export_snapshot).put(restore_snapshot),
        )
        .with_state(SnapshotState {
            manager,
            token: Arc::from(token),
        })
}

async fn export_snapshot(
    State(state): State<SnapshotState>,
    Path(lix_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.token) {
        return unauthorized();
    }
    let service = match state.manager.get_existing_for_snapshot(&lix_id).await {
        Ok(Some(service)) => service,
        Ok(None) => {
            return snapshot_error(
                StatusCode::NOT_FOUND,
                "LIX_ERROR_SNAPSHOT_SOURCE_NOT_FOUND",
                "The source lix does not exist.",
                false,
            )
        }
        Err(error) => return runtime_error(error),
    };
    let (reader, writer) = tokio::io::duplex(SNAPSHOT_STREAM_BUFFER_BYTES);
    let completion = match state
        .manager
        .spawn_snapshot_export(lix_id.clone(), service, writer.compat_write())
        .await
    {
        Ok(completion) => completion,
        Err(error) => return runtime_error(error),
    };

    let mut body_stream = export_body_stream(reader, completion).boxed();
    let Some(first) = body_stream.next().await else {
        return snapshot_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            lix_sdk::LixError::CODE_INTERNAL_ERROR,
            "Unable to export the snapshot.",
            false,
        );
    };
    let first = match first {
        Ok(first) => first,
        Err(_) => {
            return snapshot_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                lix_sdk::LixError::CODE_INTERNAL_ERROR,
                "Unable to export the snapshot.",
                false,
            )
        }
    };
    let stream = stream::once(async move { Ok::<_, io::Error>(first) }).chain(body_stream);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(SNAPSHOT_MEDIA_TYPE),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{lix_id}.lixsnap\""))
            .expect("validated Lix ID is a safe attachment filename"),
    );
    response
}

fn export_body_stream(
    reader: DuplexStream,
    completion: oneshot::Receiver<Result<(), ()>>,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, io::Error>> + Send + 'static {
    stream::unfold(
        (ReaderStream::new(reader), Some(completion), false),
        |(mut reader, mut completion, reader_done)| async move {
            if !reader_done {
                if let Some(chunk) = reader.next().await {
                    return Some((chunk, (reader, completion, false)));
                }
            }
            let result = match completion.take() {
                Some(completion) => completion.await,
                None => return None,
            };
            match result {
                Ok(Ok(())) => None,
                Ok(Err(())) | Err(_) => Some((
                    Err(io::Error::other("snapshot export failed")),
                    (reader, None, true),
                )),
            }
        },
    )
}

async fn restore_snapshot(
    State(state): State<SnapshotState>,
    Path(lix_id): Path<String>,
    request: Request<Body>,
) -> Response {
    if !authorized(request.headers(), &state.token) {
        return unauthorized();
    }
    if request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        != Some("*")
    {
        return snapshot_error(
            StatusCode::PRECONDITION_REQUIRED,
            "LIX_ERROR_SNAPSHOT_PRECONDITION_REQUIRED",
            "Snapshot restore requires `If-None-Match: *`.",
            false,
        );
    }

    let body = request.into_body().into_data_stream();
    let shutdown = state.manager.snapshot_shutdown();
    let body = stream::unfold(
        (body, shutdown, false),
        |(mut body, mut shutdown, done)| async move {
            if done {
                return None;
            }
            if *shutdown.borrow() {
                return Some((
                    Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "snapshot restore cancelled during shutdown",
                    )),
                    (body, shutdown, true),
                ));
            }
            let next = tokio::time::timeout(SNAPSHOT_UPLOAD_IDLE_TIMEOUT, async {
                tokio::select! {
                    item = body.next() => item.map(|item| item.map_err(io::Error::other)),
                    _ = wait_for_shutdown(&mut shutdown) => Some(Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "snapshot restore cancelled during shutdown",
                    ))),
                }
            })
            .await;
            match next {
                Ok(Some(item)) => Some((item, (body, shutdown, false))),
                Ok(None) => None,
                Err(_) => Some((
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "snapshot upload was idle for too long",
                    )),
                    (body, shutdown, true),
                )),
            }
        },
    )
    .boxed();
    let source = StreamReader::new(body).compat();
    match state.manager.spawn_snapshot_restore(lix_id, source).await {
        Ok(Ok(())) => no_store(StatusCode::CREATED.into_response()),
        Ok(Err(error)) => restore_error(error),
        Err(error) => {
            tracing::error!(%error, "snapshot restore task panicked");
            snapshot_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                lix_sdk::LixError::CODE_INTERNAL_ERROR,
                "Snapshot restore stopped unexpectedly.",
                false,
            )
        }
    }
}

async fn wait_for_shutdown(shutdown: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == token)
}

fn unauthorized() -> Response {
    let mut response = snapshot_error(
        StatusCode::UNAUTHORIZED,
        "LIX_ERROR_UNAUTHENTICATED",
        "Invalid snapshot service token.",
        false,
    );
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

fn runtime_error(error: LixRuntimeError) -> Response {
    match error {
        LixRuntimeError::InvalidId => snapshot_error(
            StatusCode::BAD_REQUEST,
            "LIX_INVALID_ARGUMENT",
            "Invalid lix ID.",
            false,
        ),
        LixRuntimeError::AtCapacity { .. }
        | LixRuntimeError::Migrating { .. }
        | LixRuntimeError::Recovering
        | LixRuntimeError::ShuttingDown => snapshot_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "LIX_ERROR_SNAPSHOT_UNAVAILABLE",
            "The lix is temporarily unavailable for snapshot export.",
            true,
        ),
        LixRuntimeError::MigrationFailed { .. }
        | LixRuntimeError::UpgradeFailed
        | LixRuntimeError::Cleanup(_)
        | LixRuntimeError::Open(_) => {
            tracing::error!(%error, "failed to open Lix for snapshot export");
            snapshot_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                lix_sdk::LixError::CODE_INTERNAL_ERROR,
                "Unable to open the lix for snapshot export.",
                false,
            )
        }
    }
}

fn restore_error(error: SnapshotRestoreError) -> Response {
    match error {
        SnapshotRestoreError::InvalidId => snapshot_error(
            StatusCode::BAD_REQUEST,
            "LIX_INVALID_ARGUMENT",
            "Invalid lix ID.",
            false,
        ),
        SnapshotRestoreError::AlreadyExists => snapshot_error(
            StatusCode::PRECONDITION_FAILED,
            "LIX_ERROR_SNAPSHOT_DESTINATION_EXISTS",
            "The destination lix already exists.",
            false,
        ),
        SnapshotRestoreError::Busy => snapshot_error(
            StatusCode::CONFLICT,
            "LIX_ERROR_SNAPSHOT_DESTINATION_BUSY",
            "The destination lix is already active or being restored.",
            true,
        ),
        SnapshotRestoreError::AtCapacity { .. }
        | SnapshotRestoreError::ShuttingDown
        | SnapshotRestoreError::Cancelled => snapshot_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "LIX_ERROR_SNAPSHOT_UNAVAILABLE",
            "The snapshot service is temporarily unavailable.",
            true,
        ),
        SnapshotRestoreError::Restore(error) => {
            if let Some(lix_error) = error
                .chain()
                .find_map(|source| source.downcast_ref::<lix_sdk::LixError>())
            {
                if lix_error.code == lix_sdk::LixError::CODE_INVALID_SNAPSHOT {
                    return snapshot_error(
                        StatusCode::BAD_REQUEST,
                        lix_sdk::LixError::CODE_INVALID_SNAPSHOT,
                        &lix_error.message,
                        false,
                    );
                }
                if lix_error.code == lix_sdk::LixError::CODE_SNAPSHOT_IO {
                    return snapshot_error(
                        StatusCode::BAD_REQUEST,
                        lix_sdk::LixError::CODE_SNAPSHOT_IO,
                        "The snapshot upload ended before it could be restored.",
                        false,
                    );
                }
            }
            tracing::error!(error = %error, "failed to restore Lix snapshot");
            snapshot_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                lix_sdk::LixError::CODE_INTERNAL_ERROR,
                "Unable to restore the snapshot.",
                false,
            )
        }
        SnapshotRestoreError::Cleanup(error) => {
            tracing::error!(error = %error, "failed to clean up rejected snapshot restore");
            snapshot_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                lix_sdk::LixError::CODE_INTERNAL_ERROR,
                "Snapshot restore cleanup requires operator attention.",
                false,
            )
        }
    }
}

fn snapshot_error(status: StatusCode, code: &str, message: &str, retryable: bool) -> Response {
    no_store(
        (
            status,
            Json(json!({
                "error": {
                    "code": code,
                    "message": message,
                    "data": {
                        "operation": "snapshot",
                        "retryable": retryable,
                    }
                }
            })),
        )
            .into_response(),
    )
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::TestSnapshotRestoreGate;
    use bytes::Bytes;
    use futures_util::stream;
    use http_body_util::BodyExt as _;
    use tokio::io::AsyncWriteExt as _;
    use tower::ServiceExt as _;

    const TOKEN: &str = "snapshot-secret";

    fn app(manager: Arc<LixRuntimeManager>) -> Router {
        router(manager, TOKEN.to_string())
    }

    fn authorized_request(method: &str, uri: &str, body: Body) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(body)
            .expect("snapshot request")
    }

    async fn export(app: &Router, lix_id: &str) -> Vec<u8> {
        let response = app
            .clone()
            .oneshot(authorized_request(
                "GET",
                &format!("/_ops/lixes/{lix_id}/snapshot"),
                Body::empty(),
            ))
            .await
            .expect("snapshot export response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            SNAPSHOT_MEDIA_TYPE
        );
        response
            .into_body()
            .collect()
            .await
            .expect("complete snapshot export")
            .to_bytes()
            .to_vec()
    }

    async fn restore(app: &Router, lix_id: &str, bytes: Vec<u8>) -> Response {
        let mut request = authorized_request(
            "PUT",
            &format!("/_ops/lixes/{lix_id}/snapshot"),
            Body::from(bytes),
        );
        request
            .headers_mut()
            .insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        app.clone()
            .oneshot(request)
            .await
            .expect("snapshot restore response")
    }

    #[tokio::test]
    async fn snapshot_routes_require_the_dedicated_token() {
        let response = app(LixRuntimeManager::new_in_memory(2))
            .oneshot(
                Request::builder()
                    .uri("/_ops/lixes/source/snapshot")
                    .body(Body::empty())
                    .expect("unauthorized request"),
            )
            .await
            .expect("unauthorized response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "Bearer");
    }

    #[tokio::test]
    async fn restore_requires_create_only_precondition() {
        let response = app(LixRuntimeManager::new_in_memory(2))
            .oneshot(authorized_request(
                "PUT",
                "/_ops/lixes/restored/snapshot",
                Body::empty(),
            ))
            .await
            .expect("precondition response");
        assert_eq!(response.status(), StatusCode::PRECONDITION_REQUIRED);
    }

    #[tokio::test]
    async fn producer_failure_is_a_terminal_http_body_error() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let (completed, completion) = oneshot::channel();
        tokio::spawn(async move {
            writer.write_all(b"partial snapshot").await.expect("write");
            drop(writer);
            completed.send(Err(())).expect("completion receiver");
        });

        let result = Body::from_stream(export_body_stream(reader, completion))
            .collect()
            .await;
        assert!(result.is_err(), "truncated exports must not end cleanly");
    }

    #[tokio::test]
    async fn snapshot_exports_are_bounded_and_cancelled_on_shutdown() {
        let manager = LixRuntimeManager::new_in_memory(1);
        let service = manager.get("source").await.expect("seed source Lix");
        let (_reader, writer) = tokio::io::duplex(1);
        let completion = manager
            .spawn_snapshot_export(
                "source".to_string(),
                Arc::clone(&service),
                writer.compat_write(),
            )
            .await
            .expect("first export");
        let (_second_reader, second_writer) = tokio::io::duplex(1);
        assert!(matches!(
            manager
                .spawn_snapshot_export("source".to_string(), service, second_writer.compat_write(),)
                .await,
            Err(LixRuntimeError::AtCapacity { max: 1 })
        ));

        tokio::time::timeout(std::time::Duration::from_secs(1), manager.shutdown())
            .await
            .expect("shutdown must cancel stalled export")
            .expect("clean shutdown");
        assert_eq!(completion.await.expect("export completion"), Err(()));
        assert_eq!(manager.snapshot_export_count().await, 0);
    }

    #[tokio::test]
    async fn exporting_a_missing_lix_does_not_create_it() {
        let manager = LixRuntimeManager::new_in_memory(2);
        let response = app(Arc::clone(&manager))
            .oneshot(authorized_request(
                "GET",
                "/_ops/lixes/missing/snapshot",
                Body::empty(),
            ))
            .await
            .expect("missing export response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(manager.cached_lix_count().await, 0);
    }

    #[tokio::test]
    async fn exported_snapshot_restores_to_a_fresh_lix() {
        let manager = LixRuntimeManager::new_in_memory(3);
        drop(manager.get("source").await.expect("seed source Lix"));
        let app = app(manager);
        let source = export(&app, "source").await;
        assert!(source.starts_with(b"LIXSNAP\0"));

        let restored = restore(&app, "restored", source.clone()).await;
        if restored.status() != StatusCode::CREATED {
            let status = restored.status();
            let body = restored
                .into_body()
                .collect()
                .await
                .expect("error body")
                .to_bytes();
            panic!(
                "restore returned {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }
        assert_eq!(
            restore(&app, "restored", source.clone()).await.status(),
            StatusCode::PRECONDITION_FAILED
        );
        assert_eq!(export(&app, "restored").await, source);
    }

    #[tokio::test]
    async fn cached_existing_destination_fails_the_create_precondition() {
        let manager = LixRuntimeManager::new_in_memory(2);
        drop(manager.get("existing").await.expect("seed existing Lix"));
        let response = restore(&app(manager), "existing", b"unused".to_vec()).await;
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
    }

    #[tokio::test]
    async fn malformed_restore_is_cleaned_up_and_can_be_retried() {
        let manager = LixRuntimeManager::new_in_memory(3);
        drop(manager.get("source").await.expect("seed source Lix"));
        let app = app(manager);
        let source = export(&app, "source").await;
        let rejected = restore(&app, "retry", b"not a snapshot".to_vec()).await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);

        let restored = restore(&app, "retry", source).await;
        if restored.status() != StatusCode::CREATED {
            let status = restored.status();
            let body = restored
                .into_body()
                .collect()
                .await
                .expect("error body")
                .to_bytes();
            panic!(
                "retry returned {status}: {}",
                String::from_utf8_lossy(&body)
            );
        }
    }

    #[tokio::test]
    async fn conditional_locator_serializes_restores_across_managers() {
        let object_store: Arc<dyn object_store::ObjectStore> =
            Arc::new(object_store::memory::InMemory::new());
        let first_manager =
            LixRuntimeManager::new_in_memory_with_store(4, Arc::clone(&object_store));
        let second_manager = LixRuntimeManager::new_in_memory_with_store(4, object_store);
        drop(first_manager.get("source").await.expect("seed source Lix"));
        let first_app = app(Arc::clone(&first_manager));
        let second_app = app(second_manager);
        let source = export(&first_app, "source").await;

        let (release, stalled) = tokio::sync::oneshot::channel::<()>();
        let body = Body::from_stream(stream::once(async move {
            let _ = stalled.await;
            Ok::<Bytes, io::Error>(Bytes::new())
        }));
        let mut request = authorized_request("PUT", "/_ops/lixes/claimed/snapshot", body);
        request
            .headers_mut()
            .insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        let first_restore_app = first_app.clone();
        let first_restore = tokio::spawn(async move { first_restore_app.oneshot(request).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while first_manager.snapshot_restore_count().await == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first manager owns restore");

        assert_eq!(
            restore(&second_app, "claimed", source.clone())
                .await
                .status(),
            StatusCode::CONFLICT
        );
        drop(release);
        let rejected = first_restore
            .await
            .expect("first restore task")
            .expect("first restore response");
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            restore(&second_app, "claimed", source).await.status(),
            StatusCode::CREATED
        );
    }

    #[tokio::test]
    async fn ambiguous_claim_retains_the_local_quarantine() {
        let manager = LixRuntimeManager::new_in_memory_with_ambiguous_claim(2);
        let response = restore(&app(Arc::clone(&manager)), "ambiguous", Vec::new()).await;

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(manager.snapshot_restore_count().await, 1);
        assert!(matches!(
            manager.get("ambiguous").await,
            Err(LixRuntimeError::Recovering)
        ));
    }

    #[tokio::test]
    async fn rejected_restore_cleanup_does_not_touch_a_sibling_lix() {
        let manager = LixRuntimeManager::new_in_memory(4);
        drop(manager.get("source").await.expect("seed source Lix"));
        drop(
            manager
                .get("retry-sibling")
                .await
                .expect("seed sibling Lix"),
        );
        let app = app(manager);
        let sibling_before = export(&app, "retry-sibling").await;

        assert_eq!(
            restore(&app, "retry", b"not a snapshot".to_vec())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(export(&app, "retry-sibling").await, sibling_before);
    }

    #[tokio::test]
    async fn cancelled_http_restore_keeps_its_reservation_until_cleanup() {
        let manager = LixRuntimeManager::new_in_memory(3);
        drop(manager.get("source").await.expect("seed source Lix"));
        let app = app(Arc::clone(&manager));
        let source = export(&app, "source").await;
        let (release, stalled) = tokio::sync::oneshot::channel::<()>();
        let body = Body::from_stream(stream::once(async move {
            let _ = stalled.await;
            Ok::<Bytes, io::Error>(Bytes::new())
        }));
        let mut request = authorized_request("PUT", "/_ops/lixes/cancelled/snapshot", body);
        request
            .headers_mut()
            .insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        let restoring_app = app.clone();
        let request_task = tokio::spawn(async move { restoring_app.oneshot(request).await });

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while manager.snapshot_restore_count().await == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restore reservation should become visible");
        assert_eq!(
            restore(&app, "cancelled", source.clone()).await.status(),
            StatusCode::CONFLICT
        );

        request_task.abort();
        let _ = request_task.await;
        drop(release);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while manager.snapshot_restore_count().await != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled body cleanup should release reservation");
        assert_eq!(
            restore(&app, "cancelled", source).await.status(),
            StatusCode::CREATED
        );
    }

    #[tokio::test]
    async fn shutdown_cancels_a_stalled_snapshot_upload() {
        let manager = LixRuntimeManager::new_in_memory(2);
        let app = app(Arc::clone(&manager));
        let body = Body::from_stream(stream::pending::<Result<Bytes, io::Error>>());
        let mut request = authorized_request("PUT", "/_ops/lixes/stalled/snapshot", body);
        request
            .headers_mut()
            .insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        let request_task = tokio::spawn(async move { app.oneshot(request).await });

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while manager.snapshot_restore_count().await == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restore reservation");
        tokio::time::timeout(std::time::Duration::from_secs(1), manager.shutdown())
            .await
            .expect("shutdown must cancel stalled upload")
            .expect("clean shutdown");
        let response = request_task
            .await
            .expect("request task")
            .expect("restore response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(manager.snapshot_restore_count().await, 0);
    }

    #[tokio::test]
    async fn shutdown_cancels_restore_work_after_upload_eof() {
        let gate = TestSnapshotRestoreGate {
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        let entered = Arc::clone(&gate.entered);
        let release = Arc::clone(&gate.release);
        let manager = LixRuntimeManager::new_in_memory_with_restore_gate(3, gate);
        drop(manager.get("source").await.expect("seed source Lix"));
        let app = app(Arc::clone(&manager));
        let snapshot = export(&app, "source").await;
        let restore_app = app.clone();
        let restore_task =
            tokio::spawn(async move { restore(&restore_app, "post-eof", snapshot).await });

        tokio::time::timeout(std::time::Duration::from_secs(1), entered.notified())
            .await
            .expect("restore reached post-verification gate");
        let unpublished = app
            .oneshot(authorized_request(
                "GET",
                "/_ops/lixes/post-eof/snapshot",
                Body::empty(),
            ))
            .await
            .expect("unpublished destination response");
        assert_eq!(unpublished.status(), StatusCode::SERVICE_UNAVAILABLE);
        let shutdown_manager = Arc::clone(&manager);
        let shutdown_task = tokio::spawn(async move { shutdown_manager.shutdown().await });
        tokio::task::yield_now().await;
        assert!(
            !shutdown_task.is_finished(),
            "shutdown must await the non-detachable blocking close"
        );
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_task)
            .await
            .expect("shutdown must cancel post-EOF restore work")
            .expect("shutdown task")
            .expect("clean shutdown");
        let response = restore_task.await.expect("restore task");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(manager.snapshot_restore_count().await, 0);
    }
}
