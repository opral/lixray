use crate::error::{ApiError, ErrorEnvelope};
use crate::store::{
    FilesystemEntryKind, FilesystemMutation, FilesystemMutationOutcome, LixService,
};
use axum::{
    extract::{Json, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Router,
};
use lix_engine::{
    CreateBranchOptions, ExecuteOptions, ExecuteResult, LixError, ObserveEvent, Row, Value,
    WireValue,
};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Clone)]
pub struct AppState {
    service: Arc<LixService>,
}

pub fn router(service: Arc<LixService>) -> Router {
    Router::new()
        .route("/v1/container-health", get(container_health))
        .route("/v1/branches", get(list_branches))
        .route("/v1/createBranch", post(create_branch))
        .route("/v1/execute", post(execute))
        .route("/v1/filesystem/mutate", post(mutate_filesystem))
        .route("/v1/observe", post(observe))
        .route("/v1/observe/multiplex", post(observe_multiplex))
        .with_state(AppState { service })
}

async fn container_health() -> impl IntoResponse {
    Json(HealthBody {
        ok: true,
        service: "lixray-container",
    })
}

async fn list_branches(State(state): State<AppState>) -> Result<Json<BranchesResponse>, ApiError> {
    let result = state.service.list_branches().await?;
    let branches = result
        .rows()
        .iter()
        .map(branch_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(BranchesResponse { branches }))
}

async fn create_branch(
    State(state): State<AppState>,
    Json(request): Json<CreateBranchRequest>,
) -> Result<Json<CreateBranchResponse>, ApiError> {
    let branch_id = required_non_empty(request.branch_id, "branchId")?;
    let name = required_non_empty(request.name, "name")?;
    let id = optional_uuid(request.id, "id")?;
    let receipt = state
        .service
        .create_branch(
            branch_id,
            CreateBranchOptions {
                id,
                name,
                from_commit_id: request.from_commit_id,
            },
        )
        .await?;

    Ok(Json(CreateBranchResponse {
        id: receipt.id,
        name: receipt.name,
        hidden: receipt.hidden,
        commit_id: receipt.commit_id,
    }))
}

async fn execute(
    State(state): State<AppState>,
    Json(request): Json<ExecuteRequest>,
) -> Result<Json<ExecuteScriptResponse>, ApiError> {
    let branch_id = required_non_empty(request.branch_id, "branchId")?;
    let sql = required_non_empty(request.sql, "sql")?;
    let params = decode_params(request.params)?;
    let options = ExecuteOptions {
        origin_key: request.options.and_then(|options| options.origin_key),
    };
    let results = state
        .service
        .execute_script(branch_id, sql, params, options)
        .await?
        .into_iter()
        .map(ExecuteResponse::try_from)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(ExecuteScriptResponse { results }))
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

async fn observe(
    State(state): State<AppState>,
    Json(request): Json<ObserveRequest>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let branch_id = required_non_empty(request.branch_id, "branchId")?;
    let sql = required_non_empty(request.sql, "sql")?;
    let params = decode_params(request.params)?;
    let mut events = state.service.observe(branch_id, sql, params).await?;

    let stream = async_stream::stream! {
        loop {
            match events.next().await {
                Ok(Some(event)) => {
                    match ObserveEventResponse::try_from(event) {
                        Ok(payload) => yield Ok(sse_json_event("next", &payload)),
                        Err(error) => {
                            yield Ok(sse_json_event("error", &ErrorEnvelope::from_lix_error(&error)));
                            break;
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    yield Ok(sse_json_event("error", &ErrorEnvelope::from_lix_error(&error)));
                    break;
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn observe_multiplex(
    State(state): State<AppState>,
    Json(request): Json<MultiplexObserveRequest>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let branch_id = required_non_empty(request.branch_id, "branchId")?;
    let (sender, mut receiver) = mpsc::channel::<MultiplexObserveMessage>(64);
    let mut tasks = Vec::with_capacity(request.subscriptions.len());

    for subscription in request.subscriptions {
        let subscription_id = required_non_empty(subscription.id, "subscriptions[].id")?;
        let sql = required_non_empty(subscription.sql, "subscriptions[].sql")?;
        let params = decode_params(subscription.params)?;
        let mut events = state
            .service
            .observe(branch_id.clone(), sql, params)
            .await?;
        let sender = sender.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                let message = match events.next().await {
                    Ok(Some(event)) => match ObserveEventResponse::try_from(event) {
                        Ok(payload) => MultiplexObserveMessage::Next {
                            subscription_id: subscription_id.clone(),
                            payload,
                        },
                        Err(error) => MultiplexObserveMessage::Error {
                            subscription_id: subscription_id.clone(),
                            error: ErrorEnvelope::from_lix_error(&error),
                        },
                    },
                    Ok(None) => break,
                    Err(error) => MultiplexObserveMessage::Error {
                        subscription_id: subscription_id.clone(),
                        error: ErrorEnvelope::from_lix_error(&error),
                    },
                };
                let terminal = matches!(message, MultiplexObserveMessage::Error { .. });
                if sender.send(message).await.is_err() || terminal {
                    break;
                }
            }
        }));
    }
    drop(sender);

    let stream = async_stream::stream! {
        let _task_guard = ObserveTaskGuard(tasks);
        while let Some(message) = receiver.recv().await {
            match message {
                MultiplexObserveMessage::Next { subscription_id, payload } => {
                    yield Ok(sse_json_event("next", &MultiplexObserveEventResponse {
                        subscription_id,
                        sequence: payload.sequence,
                        mutation_sequence: payload.mutation_sequence,
                        result: payload.result,
                    }));
                }
                MultiplexObserveMessage::Error { subscription_id, error } => {
                    yield Ok(sse_json_event("error", &MultiplexObserveErrorResponse {
                        subscription_id,
                        error,
                    }));
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

struct ObserveTaskGuard(Vec<JoinHandle<()>>);

impl Drop for ObserveTaskGuard {
    fn drop(&mut self) {
        for task in self.0.drain(..) {
            task.abort();
        }
    }
}

fn sse_json_event<T>(event: &'static str, payload: &T) -> Event
where
    T: Serialize,
{
    match serde_json::to_string(payload) {
        Ok(data) => Event::default().event(event).data(data),
        Err(error) => Event::default().event("error").data(
            serde_json::to_string(&ErrorEnvelope::from_lix_error(&LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("failed to serialize SSE event: {error}"),
            )))
            .unwrap_or_else(|_| {
                "{\"error\":{\"code\":\"LIX_INTERNAL_ERROR\",\"message\":\"internal server error\"}}"
                    .to_string()
            }),
        ),
    }
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

fn optional_uuid(value: Option<String>, field: &'static str) -> Result<Option<String>, ApiError> {
    value
        .map(|value| {
            let id = uuid::Uuid::parse_str(value.trim())
                .map_err(|_| ApiError::bad_request(format!("{field} must be a UUID")))?;
            let version = id.get_version_num();
            if !id.is_nil()
                && !id.is_max()
                && (id.get_variant() != uuid::Variant::RFC4122 || !(1..=8).contains(&version))
            {
                return Err(ApiError::bad_request(format!("{field} must be a UUID")));
            }
            Ok(id.hyphenated().to_string())
        })
        .transpose()
}

fn branch_from_row(row: &Row) -> Result<BranchResponse, ApiError> {
    Ok(BranchResponse {
        id: required_text(row, "id")?,
        name: required_text(row, "name")?,
        hidden: required_bool(row, "hidden")?,
        commit_id: required_text(row, "commit_id")?,
    })
}

fn required_text(row: &Row, column: &str) -> Result<String, ApiError> {
    match row.value(column)? {
        Value::Text(value) => Ok(value.clone()),
        value => Err(ApiError::from(anyhow::anyhow!(
            "expected text column {column}, got {value:?}"
        ))),
    }
}

fn required_bool(row: &Row, column: &str) -> Result<bool, ApiError> {
    match row.value(column)? {
        Value::Boolean(value) => Ok(*value),
        value => Err(ApiError::from(anyhow::anyhow!(
            "expected bool column {column}, got {value:?}"
        ))),
    }
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
    service: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
struct BranchesResponse {
    branches: Vec<BranchResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchResponse {
    id: String,
    name: String,
    hidden: bool,
    commit_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBranchRequest {
    branch_id: Option<String>,
    id: Option<String>,
    name: Option<String>,
    from_commit_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBranchResponse {
    id: String,
    name: String,
    hidden: bool,
    commit_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteRequest {
    branch_id: Option<String>,
    sql: Option<String>,
    #[serde(default)]
    params: Vec<WireValue>,
    options: Option<ExecuteOptionsRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteOptionsRequest {
    origin_key: Option<String>,
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

#[derive(Debug, Serialize, Deserialize)]
struct FilesystemMutationResponse {
    outcome: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObserveRequest {
    branch_id: Option<String>,
    sql: Option<String>,
    #[serde(default)]
    params: Vec<WireValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultiplexObserveRequest {
    branch_id: Option<String>,
    subscriptions: Vec<MultiplexObserveSubscription>,
}

#[derive(Debug, Deserialize)]
struct MultiplexObserveSubscription {
    id: Option<String>,
    sql: Option<String>,
    #[serde(default)]
    params: Vec<WireValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteResponse {
    columns: Vec<String>,
    rows: Vec<Vec<WireValue>>,
    rows_affected: u64,
    notices: Vec<lix_engine::LixNotice>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExecuteScriptResponse {
    results: Vec<ExecuteResponse>,
}

impl TryFrom<ExecuteResult> for ExecuteResponse {
    type Error = LixError;

    fn try_from(result: ExecuteResult) -> Result<Self, Self::Error> {
        let rows = result
            .rows()
            .iter()
            .map(|row| {
                row.values()
                    .iter()
                    .map(WireValue::try_from_engine)
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            columns: result.columns().to_vec(),
            rows,
            rows_affected: result.rows_affected(),
            notices: result.notices().to_vec(),
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObserveEventResponse {
    sequence: u64,
    mutation_sequence: u64,
    result: ExecuteResponse,
}

enum MultiplexObserveMessage {
    Next {
        subscription_id: String,
        payload: ObserveEventResponse,
    },
    Error {
        subscription_id: String,
        error: ErrorEnvelope,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiplexObserveEventResponse {
    subscription_id: String,
    sequence: u64,
    mutation_sequence: u64,
    result: ExecuteResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiplexObserveErrorResponse {
    subscription_id: String,
    #[serde(flatten)]
    error: ErrorEnvelope,
}

impl TryFrom<ObserveEvent> for ObserveEventResponse {
    type Error = LixError;

    fn try_from(event: ObserveEvent) -> Result<Self, Self::Error> {
        Ok(Self {
            sequence: event.sequence,
            mutation_sequence: event.mutation_sequence,
            result: ExecuteResponse::try_from(event.rows)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{open_lix_service, Config, StorageConfig};
    use axum::body::Body;
    use http::{Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value as JsonValue};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tower::ServiceExt;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    async fn app() -> Router {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let config = Config {
            bind_addr: "127.0.0.1:0".to_string(),
            slatedb_path: format!("test-{}-{id}", std::process::id()),
            storage: StorageConfig::Memory,
        };
        let service = open_lix_service(&config).await.unwrap();
        router(service)
    }

    async fn json_request(
        app: Router,
        method: Method,
        uri: &str,
        body: JsonValue,
    ) -> http::Response<Body> {
        app.oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn response_json<T>(response: http::Response<Body>) -> T
    where
        T: serde::de::DeserializeOwned,
    {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn single_execute_response(response: http::Response<Body>) -> ExecuteResponse {
        let response: ExecuteScriptResponse = response_json(response).await;
        let [result] = <[ExecuteResponse; 1]>::try_from(response.results)
            .expect("single statement returns one result");
        result
    }

    async fn main_branch_id(app: Router) -> String {
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/branches")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let branches: BranchesResponse = response_json(response).await;
        branches
            .branches
            .into_iter()
            .find(|branch| branch.name == "main")
            .expect("main branch exists")
            .id
    }

    #[tokio::test]
    async fn branches_returns_main_branch() {
        let app = app().await;
        let main = main_branch_id(app).await;

        assert!(!main.is_empty());
    }

    #[tokio::test]
    async fn execute_can_insert_and_select_key_value() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;

        let insert = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
                "params": [
                    { "kind": "text", "value": "http-key" },
                    { "kind": "text", "value": "http-value" }
                ]
            }),
        )
        .await;
        assert_eq!(insert.status(), StatusCode::OK);
        let insert_body = single_execute_response(insert).await;
        assert_eq!(insert_body.rows_affected, 1);

        let select = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT value FROM lix_key_value WHERE key = $1",
                "params": [{ "kind": "text", "value": "http-key" }]
            }),
        )
        .await;
        assert_eq!(select.status(), StatusCode::OK);
        let select_body = single_execute_response(select).await;
        assert_eq!(
            select_body.rows,
            vec![vec![WireValue::Json {
                value: json!("http-value")
            }]]
        );
    }

    #[tokio::test]
    async fn execute_supports_explicit_transactions_and_ordered_results() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        let response = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "BEGIN; INSERT INTO lix_key_value (key, value) VALUES ($1, $2); INSERT INTO lix_key_value (key, value) VALUES ($3, $4); SELECT key FROM lix_key_value WHERE key IN ($1, $3) ORDER BY key; COMMIT;",
                "params": [
                    { "kind": "text", "value": "batch-a" },
                    { "kind": "text", "value": "value-a" },
                    { "kind": "text", "value": "batch-b" },
                    { "kind": "text", "value": "value-b" }
                ],
                "options": { "originKey": "http-transaction" }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body: ExecuteScriptResponse = response_json(response).await;
        assert_eq!(body.results.len(), 3);
        assert_eq!(body.results[0].rows_affected, 1);
        assert_eq!(body.results[1].rows_affected, 1);
        assert_eq!(
            body.results[2].rows,
            vec![
                vec![WireValue::Text {
                    value: "batch-a".to_string()
                }],
                vec![WireValue::Text {
                    value: "batch-b".to_string()
                }]
            ]
        );

        let origin_response = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT origin_key FROM lix_change WHERE origin_key = $1",
                "params": [{ "kind": "text", "value": "http-transaction" }]
            }),
        )
        .await;
        assert_eq!(origin_response.status(), StatusCode::OK);
        let origin_body = single_execute_response(origin_response).await;
        assert_eq!(origin_body.rows.len(), 2);
    }

    #[tokio::test]
    async fn execute_auto_wraps_anonymous_params_and_rolls_back_on_error() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        let success = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "INSERT INTO lix_key_value (key, value) VALUES (?, ?); SELECT key FROM lix_key_value WHERE key = ?",
                "params": [
                    { "kind": "text", "value": "anonymous-batch" },
                    { "kind": "text", "value": "value" },
                    { "kind": "text", "value": "anonymous-batch" }
                ]
            }),
        )
        .await;
        assert_eq!(success.status(), StatusCode::OK);
        let success_body: ExecuteScriptResponse = response_json(success).await;
        assert_eq!(success_body.results.len(), 2);
        assert_eq!(success_body.results[1].rows.len(), 1);

        let failed = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "INSERT INTO lix_key_value (key, value) VALUES ($1, $2); INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
                "params": [
                    { "kind": "text", "value": "rolled-back-batch" },
                    { "kind": "text", "value": "value" }
                ]
            }),
        )
        .await;
        assert_eq!(failed.status(), StatusCode::BAD_REQUEST);

        let select = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT key FROM lix_key_value WHERE key = $1",
                "params": [{ "kind": "text", "value": "rolled-back-batch" }]
            }),
        )
        .await;
        let select_body = single_execute_response(select).await;
        assert!(select_body.rows.is_empty());
    }

    #[tokio::test]
    async fn execute_preserves_structured_script_parser_errors() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;

        let unsupported = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "BEGIN WORK; SELECT 1; COMMIT"
            }),
        )
        .await;
        assert_eq!(unsupported.status(), StatusCode::BAD_REQUEST);
        let unsupported_body: JsonValue = response_json(unsupported).await;
        assert_eq!(
            unsupported_body["error"]["code"],
            LixError::CODE_UNSUPPORTED_SQL
        );
        assert!(unsupported_body["error"]["hint"].is_string());

        let empty = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({ "branchId": branch_id, "sql": "BEGIN; COMMIT" }),
        )
        .await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
        let empty_body: JsonValue = response_json(empty).await;
        assert_eq!(empty_body["error"]["code"], LixError::CODE_UNSUPPORTED_SQL);

        let mixed = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT ?; SELECT $2",
                "params": [
                    { "kind": "text", "value": "one" },
                    { "kind": "text", "value": "two" }
                ]
            }),
        )
        .await;
        assert_eq!(mixed.status(), StatusCode::BAD_REQUEST);
        let mixed_body: JsonValue = response_json(mixed).await;
        assert_eq!(mixed_body["error"]["code"], LixError::CODE_PARSE_ERROR);

        let mismatched = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT $1; SELECT $2",
                "params": [{ "kind": "text", "value": "one" }]
            }),
        )
        .await;
        assert_eq!(mismatched.status(), StatusCode::BAD_REQUEST);
        let mismatched_body: JsonValue = response_json(mismatched).await;
        assert_eq!(
            mismatched_body["error"]["code"],
            LixError::CODE_INVALID_PARAM
        );
        assert_eq!(
            mismatched_body["error"]["details"]["expected_param_count"],
            2
        );
        assert_eq!(
            mismatched_body["error"]["details"]["provided_param_count"],
            1
        );
    }

    #[tokio::test]
    async fn filesystem_mutations_compare_revision_atomically() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        for path in ["/move-source.txt", "/move-taken.txt"] {
            let response = json_request(
                app.clone(),
                Method::POST,
                "/v1/execute",
                json!({
                    "branchId": branch_id,
                    "sql": "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
                    "params": [
                        { "kind": "text", "value": path },
                        { "kind": "blob", "base64": "aGVsbG8=" }
                    ]
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }

        let revision_response = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT lixcol_change_id FROM lix_file WHERE path = $1",
                "params": [{ "kind": "text", "value": "/move-source.txt" }]
            }),
        )
        .await;
        let revision_body = single_execute_response(revision_response).await;
        let revision = match &revision_body.rows[0][0] {
            WireValue::Text { value } => value.clone(),
            value => panic!("expected text revision, got {value:?}"),
        };

        let collision = json_request(
            app.clone(),
            Method::POST,
            "/v1/filesystem/mutate",
            json!({
                "branchId": branch_id,
                "kind": "file",
                "path": "/move-source.txt",
                "expectedRevision": revision,
                "mutation": { "type": "move", "destinationPath": "/move-taken.txt" }
            }),
        )
        .await;
        assert_eq!(collision.status(), StatusCode::OK);
        let collision_body: FilesystemMutationResponse = response_json(collision).await;
        assert_eq!(collision_body.outcome, "already_exists");

        let moved = json_request(
            app.clone(),
            Method::POST,
            "/v1/filesystem/mutate",
            json!({
                "branchId": branch_id,
                "kind": "file",
                "path": "/move-source.txt",
                "expectedRevision": revision,
                "mutation": { "type": "move", "destinationPath": "/move-renamed.txt" }
            }),
        )
        .await;
        assert_eq!(moved.status(), StatusCode::OK);
        let moved_body: FilesystemMutationResponse = response_json(moved).await;
        assert_eq!(moved_body.outcome, "applied");

        let stale_delete = json_request(
            app.clone(),
            Method::POST,
            "/v1/filesystem/mutate",
            json!({
                "branchId": branch_id,
                "kind": "file",
                "path": "/move-renamed.txt",
                "expectedRevision": "stale-revision",
                "mutation": { "type": "delete" }
            }),
        )
        .await;
        let stale_body: FilesystemMutationResponse = response_json(stale_delete).await;
        assert_eq!(stale_body.outcome, "conflict");

        let select = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "SELECT path FROM lix_file WHERE path = $1",
                "params": [{ "kind": "text", "value": "/move-renamed.txt" }]
            }),
        )
        .await;
        let select_body = single_execute_response(select).await;
        assert_eq!(select_body.rows.len(), 1);
    }

    #[tokio::test]
    async fn create_branch_creates_from_supplied_branch() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        let draft_id = "44444444-4444-4444-8444-444444444444";

        let response = json_request(
            app,
            Method::POST,
            "/v1/createBranch",
            json!({
                "branchId": branch_id,
                "id": draft_id,
                "name": "HTTP draft"
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: CreateBranchResponse = response_json(response).await;
        assert_eq!(body.id, draft_id);
        assert_eq!(body.name, "HTTP draft");
        assert!(!body.commit_id.is_empty());
    }

    #[tokio::test]
    async fn create_branch_rejects_ids_outside_the_mcp_uuid_contract() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        for id in ["http-draft", "99999999-9999-9999-9999-999999999999"] {
            let response = json_request(
                app.clone(),
                Method::POST,
                "/v1/createBranch",
                json!({
                    "branchId": branch_id,
                    "id": id,
                    "name": "HTTP draft"
                }),
            )
            .await;

            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body: JsonValue = response_json(response).await;
            assert_eq!(body["error"]["code"], "LIX_INVALID_ARGUMENT");
            assert_eq!(body["error"]["message"], "id must be a UUID");
        }
    }

    #[tokio::test]
    async fn execute_uses_supplied_branch_context() {
        let app = app().await;
        let main_branch_id = main_branch_id(app.clone()).await;
        let draft_id = "55555555-5555-4555-8555-555555555555";
        let draft = json_request(
            app.clone(),
            Method::POST,
            "/v1/createBranch",
            json!({
                "branchId": main_branch_id,
                "id": draft_id,
                "name": "HTTP branch context"
            }),
        )
        .await;
        assert_eq!(draft.status(), StatusCode::OK);

        let file_path = "/http-branch-file.txt";
        let insert = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": main_branch_id,
                "sql": "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
                "params": [
                    { "kind": "text", "value": file_path },
                    { "kind": "blob", "base64": "aGVsbG8=" }
                ]
            }),
        )
        .await;
        assert_eq!(insert.status(), StatusCode::OK);

        let main_select = json_request(
            app.clone(),
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": main_branch_id,
                "sql": "SELECT path FROM lix_file WHERE path = $1",
                "params": [{ "kind": "text", "value": file_path }]
            }),
        )
        .await;
        let main_body = single_execute_response(main_select).await;
        assert_eq!(main_body.rows.len(), 1);

        let draft_select = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": draft_id,
                "sql": "SELECT path FROM lix_file WHERE path = $1",
                "params": [{ "kind": "text", "value": file_path }]
            }),
        )
        .await;
        let draft_body = single_execute_response(draft_select).await;
        assert_eq!(draft_body.rows.len(), 0);
    }

    async fn next_sse_frame(body: &mut Body) -> String {
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        String::from_utf8(data.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn observe_emits_initial_event_and_matching_update() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;

        let response = json_request(
            app.clone(),
            Method::POST,
            "/v1/observe",
            json!({
                "branchId": branch_id,
                "sql": "SELECT key FROM lix_key_value WHERE key = $1",
                "params": [{ "kind": "text", "value": "observe-http" }]
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/event-stream"
        );

        let mut body = response.into_body();
        let initial = next_sse_frame(&mut body).await;
        assert!(initial.contains("event: next"));
        assert!(initial.contains("\"sequence\":0"));

        let insert = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": branch_id,
                "sql": "INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
                "params": [
                    { "kind": "text", "value": "observe-http" },
                    { "kind": "text", "value": "updated" }
                ]
            }),
        )
        .await;
        assert_eq!(insert.status(), StatusCode::OK);

        let update = next_sse_frame(&mut body).await;
        assert!(update.contains("event: next"));
        assert!(update.contains("\"sequence\":1"));
        assert!(update.contains("observe-http"));
    }

    #[tokio::test]
    async fn invalid_requests_are_structured_errors() {
        let app = app().await;
        let response = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "sql": "SELECT 1"
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: JsonValue = response_json(response).await;
        assert_eq!(body["error"]["code"], "LIX_INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn observe_rejects_write_sql() {
        let app = app().await;
        let branch_id = main_branch_id(app.clone()).await;
        let response = json_request(
            app,
            Method::POST,
            "/v1/observe",
            json!({
                "branchId": branch_id,
                "sql": "INSERT INTO lix_key_value (key, value) VALUES ('bad', 'bad')"
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: JsonValue = response_json(response).await;
        assert_eq!(body["error"]["code"], LixError::CODE_INVALID_PARAM);
    }

    #[tokio::test]
    async fn unknown_branch_returns_404() {
        let app = app().await;
        let response = json_request(
            app,
            Method::POST,
            "/v1/execute",
            json!({
                "branchId": "missing-branch",
                "sql": "SELECT lix_active_branch_commit_id()"
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: JsonValue = response_json(response).await;
        assert_eq!(body["error"]["code"], LixError::CODE_BRANCH_NOT_FOUND);
    }

    #[tokio::test]
    async fn kv_routes_are_not_exposed() {
        let response = app()
            .await
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/kv/test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
