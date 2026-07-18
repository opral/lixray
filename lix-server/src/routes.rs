use crate::store::LixService;
use axum::Router;
use std::sync::Arc;

pub fn router(service: Arc<LixService>) -> Router {
    lix_server_protocol::handler(service.protocol_lix())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open_lix_service, Config, StorageConfig};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::{json, Value as JsonValue};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tower::ServiceExt;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    async fn test_router() -> Router {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let service = open_lix_service(&Config {
            bind_addr: "127.0.0.1:0".to_string(),
            slatedb_path: format!("routes-{}-{id}", std::process::id()),
            storage: StorageConfig::Memory,
        })
        .await
        .expect("open test Lix service");
        router(service)
    }

    #[tokio::test]
    async fn exposes_only_the_canonical_lix_protocol() {
        let app = test_router().await;
        let legacy = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/execute")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"sql":"SELECT 1"}"#))
                    .expect("legacy request"),
            )
            .await
            .expect("legacy response");
        assert_eq!(legacy.status(), StatusCode::NOT_FOUND);

        let handshake = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/lix/v1/")
                    .body(Body::empty())
                    .expect("handshake request"),
            )
            .await
            .expect("handshake response");
        assert_eq!(handshake.status(), StatusCode::OK);
        let body: JsonValue = serde_json::from_slice(
            &handshake
                .into_body()
                .collect()
                .await
                .expect("handshake body")
                .to_bytes(),
        )
        .expect("handshake json");
        assert_eq!(body["protocolVersion"], json!(1));

        for path in ["/v1/container-health", "/v1/filesystem/mutate"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .expect("removed route request"),
                )
                .await
                .expect("removed route response");
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }
}
