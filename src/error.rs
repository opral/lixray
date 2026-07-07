use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug)]
pub enum ApiError {
    BadRequest(&'static str),
    NotFound,
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NotFound => (StatusCode::NOT_FOUND, "not found"),
            Self::Internal(error) => {
                tracing::error!(error = ?error, "request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
            }
        };

        (status, Json(ErrorBody { error: message })).into_response()
    }
}

impl From<slatedb::Error> for ApiError {
    fn from(error: slatedb::Error) -> Self {
        Self::Internal(error.into())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
