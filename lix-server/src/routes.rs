use crate::store::{LixService, WorkspaceRuntimeError};
use crate::WorkspaceRuntimeManager;
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

/// Keeps the workspace's one shared Engine alive until the HTTP body is
/// finished. This matters for SSE: dropping the request-scoped service lease
/// as soon as headers are returned would let workspace LRU eviction open a
/// second Engine while an observation from the first Engine is still active.
struct WorkspaceLeaseBody {
    inner: Body,
    _workspace: Arc<LixService>,
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

impl http_body::Body for WorkspaceLeaseBody {
    type Data = <Body as http_body::Body>::Data;
    type Error = <Body as http_body::Body>::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
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

    let runtime = match state.manager.get(&workspace_id).await {
        Ok(runtime) => runtime,
        Err(error) => return workspace_error(error),
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
    let handler_future = lix_server_protocol::handler(runtime.protocol()).oneshot(request);
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
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(WorkspaceLeaseBody {
            inner: body,
            _workspace: runtime,
        }),
    )
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
    use axum::http::Request;
    use http_body_util::BodyExt;
    use lix_sdk::{Value as LixValue, WireValue};
    use serde_json::{json, Value as JsonValue};
    use std::{path::PathBuf, time::Duration};

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
        let handshake = json_body(handshake).await;
        assert_eq!(handshake["protocolVersion"], json!(1));
        assert!(handshake["sessionId"].as_str().is_some());
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
        let workspace_a_session = open_protocol_session(app.clone(), "workspace-a").await;
        let insert = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/workspaces/workspace-a/lix/v1/execute")
                    .header(
                        lix_server_protocol::SESSION_ID_HEADER,
                        &workspace_a_session,
                    )
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
            let session_id = if workspace_id == "workspace-a" {
                workspace_a_session.clone()
            } else {
                open_protocol_session(app.clone(), workspace_id).await
            };
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!(
                            "/workspaces/{workspace_id}/lix/v1/execute"
                        ))
                        .header(lix_server_protocol::SESSION_ID_HEADER, session_id)
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
    async fn strict_remote_sessions_merge_disjoint_markdown_blob_edits() {
        let archive_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../vendor/lix/packages/js-sdk/dist/bundled-plugins/plugin_md_v2.lixplugin");
        let Ok(markdown_plugin) = std::fs::read(&archive_path) else {
            // The root pnpm install supplies bundled plugins. Keep standalone
            // Rust development usable before that generated artifact exists.
            eprintln!(
                "skipping native Markdown protocol test; build {} first",
                archive_path.display()
            );
            return;
        };

        let app = test_router();
        let workspace_id = "markdown-collaboration";
        let installer = open_protocol_session(app.clone(), workspace_id).await;
        expect_protocol_ok(
            protocol_execute(
                app.clone(),
                workspace_id,
                &installer,
                "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
                vec![
                    wire_value(LixValue::Text(
                        "/.lix/plugins/plugin_md_v2.lixplugin".to_string(),
                    )),
                    wire_value(LixValue::Blob(markdown_plugin)),
                ],
            )
            .await,
        )
        .await;

        let session_a = open_protocol_session(app.clone(), workspace_id).await;
        let session_b = open_protocol_session(app.clone(), workspace_id).await;
        let path = "/shared.md";
        let seed = b"# Shared\n\nLeft: 0\n\nRight: 0\n".to_vec();
        expect_protocol_ok(
            protocol_execute(
                app.clone(),
                workspace_id,
                &session_a,
                "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
                vec![
                    wire_value(LixValue::Text(path.to_string())),
                    wire_value(LixValue::Blob(seed.clone())),
                ],
            )
            .await,
        )
        .await;

        for session_id in [&session_a, &session_b] {
            let delivered = expect_protocol_ok(
                protocol_execute(
                    app.clone(),
                    workspace_id,
                    session_id,
                    "SELECT data FROM lix_file WHERE path = $1",
                    vec![wire_value(LixValue::Text(path.to_string()))],
                )
                .await,
            )
            .await;
            assert_eq!(wire_blob(&delivered), seed);
        }

        let write_a = protocol_execute(
            app.clone(),
            workspace_id,
            &session_a,
            "UPDATE lix_file SET data = $1 WHERE path = $2",
            vec![
                wire_value(LixValue::Blob(
                    b"# Shared\n\nLeft: A\n\nRight: 0\n".to_vec(),
                )),
                wire_value(LixValue::Text(path.to_string())),
            ],
        );
        let write_b = protocol_execute(
            app.clone(),
            workspace_id,
            &session_b,
            "UPDATE lix_file SET data = $1 WHERE path = $2",
            vec![
                wire_value(LixValue::Blob(
                    b"# Shared\n\nLeft: 0\n\nRight: B\n".to_vec(),
                )),
                wire_value(LixValue::Text(path.to_string())),
            ],
        );
        let (write_a, write_b) = tokio::join!(write_a, write_b);
        expect_protocol_ok(write_a).await;
        expect_protocol_ok(write_b).await;

        let merged = expect_protocol_ok(
            protocol_execute(
                app.clone(),
                workspace_id,
                &session_a,
                "SELECT data FROM lix_file WHERE path = $1",
                vec![wire_value(LixValue::Text(path.to_string()))],
            )
            .await,
        )
        .await;
        assert_eq!(
            String::from_utf8(wire_blob(&merged)).expect("merged Markdown should be UTF-8"),
            "# Shared\n\nLeft: A\n\nRight: B\n"
        );
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

    async fn protocol_execute(
        app: Router,
        workspace_id: &str,
        session_id: &str,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Response {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/workspaces/{workspace_id}/lix/v1/execute"))
                .header(lix_server_protocol::SESSION_ID_HEADER, session_id)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "sql": sql, "params": params }).to_string(),
                ))
                .expect("protocol execute request"),
        )
        .await
        .expect("protocol execute response")
    }

    async fn expect_protocol_ok(response: Response) -> JsonValue {
        let status = response.status();
        let body = json_body(response).await;
        assert_eq!(status, StatusCode::OK, "protocol response: {body}");
        body
    }

    fn wire_value(value: LixValue) -> JsonValue {
        serde_json::to_value(
            WireValue::try_from_engine(&value).expect("test value should encode to wire format"),
        )
        .expect("wire value should serialize")
    }

    fn wire_blob(response: &JsonValue) -> Vec<u8> {
        let wire: WireValue = serde_json::from_value(response["rows"][0][0].clone())
            .expect("execute response should contain a wire value");
        let LixValue::Blob(bytes) = wire
            .try_into_engine()
            .expect("wire blob should decode into an engine value")
        else {
            panic!("execute response should contain a blob");
        };
        bytes
    }

    async fn open_protocol_session(app: Router, workspace_id: &str) -> String {
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/workspaces/{workspace_id}/lix/v1/"))
                    .body(Body::empty())
                    .expect("protocol handshake request"),
            )
            .await
            .expect("protocol handshake response");
        assert_eq!(response.status(), StatusCode::OK);
        json_body(response).await["sessionId"]
            .as_str()
            .expect("handshake session id")
            .to_string()
    }
}
