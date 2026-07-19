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
use std::sync::Arc;
use tower::ServiceExt;

#[derive(Clone)]
struct AppState {
    manager: Arc<WorkspaceRuntimeManager>,
    internal_token: Option<Arc<str>>,
}

pub fn router(manager: Arc<WorkspaceRuntimeManager>, internal_token: Option<String>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/workspaces/{workspace_id}/{*protocol_path}",
            any(workspace_protocol),
        )
        .with_state(AppState {
            manager,
            internal_token: internal_token.map(Arc::from),
        })
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "service": "lix-server"}))
}

async fn workspace_protocol(
    State(state): State<AppState>,
    Path((workspace_id, protocol_path)): Path<(String, String)>,
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

    lix_server_protocol::handler(runtime.protocol_lix())
        .oneshot(request)
        .await
        .expect("canonical Lix protocol router is infallible")
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
        WorkspaceRuntimeError::AtCapacity { .. } | WorkspaceRuntimeError::Open(_) => {
            StatusCode::SERVICE_UNAVAILABLE
        }
    };
    (status, Json(json!({"error": error.to_string()}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::{json, Value as JsonValue};

    fn test_router() -> Router {
        let manager = WorkspaceRuntimeManager::new_in_memory(4);
        router(manager, None)
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
        let app = router(manager, Some("secret".to_string()));

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
}
