use crate::error::ApiError;
use crate::store::{
    FilesystemEntryKind, FilesystemMutation, FilesystemMutationOutcome, LixService,
};
use axum::{
    extract::{Json, State},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use lix_engine::{LixError, Value, WireValue};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    service: Arc<LixService>,
}

pub fn router(service: Arc<LixService>) -> Router {
    let protocol = lix_server_protocol::handler(service.protocol_lix());
    Router::new()
        .route("/v1/container-health", get(container_health))
        .route("/v1/filesystem/mutate", post(mutate_filesystem))
        .with_state(AppState { service })
        .merge(protocol)
}

async fn container_health() -> impl IntoResponse {
    Json(HealthBody {
        ok: true,
        service: "lixray-container",
    })
}

async fn mutate_filesystem(
    State(state): State<AppState>,
    Json(request): Json<FilesystemMutationRequest>,
) -> Result<Json<FilesystemMutationResponse>, ApiError> {
    let branch_id = required_non_empty(request.branch_id, "branchId")?;
    let path = required_non_empty(request.path, "path")?;
    let expected_revision = required_non_empty(request.expected_revision, "expectedRevision")?;
    let kind = match request.kind {
        FilesystemEntryKindRequest::File => FilesystemEntryKind::File,
        FilesystemEntryKindRequest::Directory => FilesystemEntryKind::Directory,
    };
    let mutation = match request.mutation {
        FilesystemMutationOperationRequest::ReplaceFile { data, metadata } => {
            let mut values = decode_params(vec![data, metadata])?;
            let metadata = values.pop().expect("two decoded mutation values");
            let data = values.pop().expect("two decoded mutation values");
            FilesystemMutation::ReplaceFile { data, metadata }
        }
        FilesystemMutationOperationRequest::Move { destination_path } => FilesystemMutation::Move {
            destination_path: required_non_empty(destination_path, "destinationPath")?,
        },
        FilesystemMutationOperationRequest::Delete => FilesystemMutation::Delete,
    };
    let outcome = state
        .service
        .mutate_filesystem(branch_id, kind, path, expected_revision, mutation)
        .await?;

    Ok(Json(FilesystemMutationResponse {
        outcome: match outcome {
            FilesystemMutationOutcome::Applied => "applied".to_string(),
            FilesystemMutationOutcome::Conflict => "conflict".to_string(),
            FilesystemMutationOutcome::AlreadyExists => "already_exists".to_string(),
        },
    }))
}

fn decode_params(params: Vec<WireValue>) -> Result<Vec<Value>, ApiError> {
    params
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            value.try_into_engine().map_err(|error| {
                ApiError::from(
                    LixError::new(
                        LixError::CODE_INVALID_PARAM,
                        format!("invalid SQL parameter at index {index}: {}", error.message),
                    )
                    .with_details(serde_json::json!({
                        "parameter_index": index,
                        "source_code": error.code,
                    })),
                )
            })
        })
        .collect()
}

fn required_non_empty(value: Option<String>, field: &'static str) -> Result<String, ApiError> {
    match value {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(ApiError::bad_request(format!("{field} is required"))),
    }
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
    service: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesystemMutationRequest {
    branch_id: Option<String>,
    kind: FilesystemEntryKindRequest,
    path: Option<String>,
    expected_revision: Option<String>,
    mutation: FilesystemMutationOperationRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FilesystemEntryKindRequest {
    File,
    Directory,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum FilesystemMutationOperationRequest {
    ReplaceFile {
        data: WireValue,
        metadata: WireValue,
    },
    Move {
        #[serde(rename = "destinationPath")]
        destination_path: Option<String>,
    },
    Delete,
}

#[derive(Debug, Serialize)]
struct FilesystemMutationResponse {
    outcome: String,
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
    async fn exposes_only_canonical_lix_protocol_and_sidecars() {
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

        let health = app
            .oneshot(
                Request::builder()
                    .uri("/v1/container-health")
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::OK);
    }
}
