use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use lix_engine::LixError;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    Lix(LixError),
    Internal(anyhow::Error),
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                ErrorEnvelope::from_parts("LIX_INVALID_ARGUMENT", message, None, None),
            ),
            Self::Lix(error) => (
                status_for_lix_error(&error),
                ErrorEnvelope::from_lix_error(&error),
            ),
            Self::Internal(error) => {
                tracing::error!(error = ?error, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ErrorEnvelope::from_parts(
                        LixError::CODE_INTERNAL_ERROR,
                        "internal server error",
                        None,
                        None,
                    ),
                )
            }
        };

        (status, Json(body)).into_response()
    }
}

impl From<LixError> for ApiError {
    fn from(error: LixError) -> Self {
        Self::Lix(error)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<JsonValue>,
}

impl ErrorEnvelope {
    pub fn from_lix_error(error: &LixError) -> Self {
        Self::from_parts(
            error.code.clone(),
            error.message.clone(),
            error.hint.clone(),
            error.details.clone(),
        )
    }

    fn from_parts(
        code: impl Into<String>,
        message: impl Into<String>,
        hint: Option<String>,
        details: Option<JsonValue>,
    ) -> Self {
        Self {
            error: ErrorBody {
                code: code.into(),
                message: message.into(),
                hint,
                details,
            },
        }
    }
}

fn status_for_lix_error(error: &LixError) -> StatusCode {
    match error.code.as_str() {
        LixError::CODE_BRANCH_NOT_FOUND
        | LixError::CODE_COMMIT_NOT_FOUND
        | LixError::CODE_TABLE_NOT_FOUND
        | LixError::CODE_COLUMN_NOT_FOUND => StatusCode::NOT_FOUND,
        LixError::CODE_INVALID_PARAM
        | LixError::CODE_PARSE_ERROR
        | LixError::CODE_BINDING_ERROR
        | LixError::CODE_TYPE_MISMATCH
        | LixError::CODE_DIALECT_UNSUPPORTED
        | LixError::CODE_UNSUPPORTED_SQL
        | LixError::CODE_UNSUPPORTED_SQL_RUNTIME_PLAN
        | LixError::CODE_CONSTRAINT_VIOLATION
        | LixError::CODE_READ_ONLY
        | LixError::CODE_SCHEMA_VALIDATION
        | LixError::CODE_FOREIGN_KEY
        | LixError::CODE_FILE_NOT_FOUND
        | LixError::CODE_UNIQUE
        | LixError::CODE_UNSUPPORTED_WRITE_EXPRESSION
        | LixError::CODE_SCHEMA_DEFINITION
        | LixError::CODE_INVALID_STORAGE_SCOPE
        | LixError::CODE_AMBIGUOUS_MERGE_BASE
        | LixError::CODE_INVALID_MERGE => StatusCode::BAD_REQUEST,
        LixError::CODE_CLOSED => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
