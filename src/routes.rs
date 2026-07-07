use crate::error::ApiError;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::Serialize;
use slatedb::Db;
use std::sync::Arc;

const MAX_KEY_BYTES: usize = 1024;

#[derive(Clone)]
pub struct AppState {
    db: Arc<Db>,
}

pub fn router(db: Arc<Db>) -> Router {
    Router::new()
        .route("/v1/container-health", get(container_health))
        .route("/v1/kv/", get(empty_key).put(empty_key).delete(empty_key))
        .route("/v1/kv/{key}", get(get_key).put(put_key).delete(delete_key))
        .with_state(AppState { db })
}

async fn container_health() -> impl IntoResponse {
    axum::Json(HealthBody {
        ok: true,
        service: "lixray-container",
    })
}

async fn get_key(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    validate_key(&key)?;

    match state.db.get(key.as_bytes()).await? {
        Some(value) => Ok(([(header::CONTENT_TYPE, "application/octet-stream")], value)),
        None => Err(ApiError::NotFound),
    }
}

async fn put_key(
    State(state): State<AppState>,
    Path(key): Path<String>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    validate_key(&key)?;
    state.db.put(key.as_bytes(), body).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_key(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    validate_key(&key)?;
    state.db.delete(key.as_bytes()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn empty_key() -> ApiError {
    ApiError::BadRequest("key must not be empty")
}

fn validate_key(key: &str) -> Result<(), ApiError> {
    if key.is_empty() {
        return Err(ApiError::BadRequest("key must not be empty"));
    }

    if key.len() > MAX_KEY_BYTES {
        return Err(ApiError::BadRequest("key is too long"));
    }

    Ok(())
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
    service: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{router, Config, StorageConfig};
    use axum::body::Body;
    use http::{Method, Request, StatusCode};
    use tower::ServiceExt;

    async fn app() -> Router {
        let config = Config {
            bind_addr: "127.0.0.1:0".to_string(),
            slatedb_path: format!("test-{}", std::process::id()),
            storage: StorageConfig::Memory,
        };
        let db = crate::open_db(&config).await.unwrap();
        router(db)
    }

    #[tokio::test]
    async fn put_get_delete_round_trip() {
        let app = app().await;

        let put_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/v1/kv/hello")
                    .body(Body::from("world"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put_response.status(), StatusCode::NO_CONTENT);

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/kv/hello")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(get_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"world");

        let delete_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/v1/kv/hello")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

        let missing_response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/kv/hello")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_key_returns_404() {
        let response = app()
            .await
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/kv/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn empty_key_returns_400() {
        let response = app()
            .await
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/v1/kv/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn overlong_key_returns_400() {
        let key = "a".repeat(MAX_KEY_BYTES + 1);
        let response = app()
            .await
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(format!("/v1/kv/{key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
