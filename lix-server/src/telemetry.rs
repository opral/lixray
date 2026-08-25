use anyhow::{Context, Result};
use lix_sdk::telemetry::{OpenTelemetryTracingSink, TelemetrySink};
use opentelemetry::{trace::TracerProvider as _, KeyValue, Value};
use opentelemetry_otlp::{Compression, Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    error::{OTelSdkError, OTelSdkResult},
    runtime,
    trace::{
        span_processor_with_async_runtime::BatchSpanProcessor, BatchConfigBuilder,
        SdkTracerProvider, SpanData, SpanExporter,
    },
    Resource,
};
use std::{
    collections::HashMap,
    env,
    sync::{Arc, Mutex},
    time::Duration,
};
use tracing::{field::Visit, span::Attributes, Subscriber};
use tracing_subscriber::{
    fmt::format::FmtSpan,
    layer::{Context as LayerContext, SubscriberExt},
    registry::LookupSpan,
    EnvFilter, Layer,
};

const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";
const PERF_SPAN_EVENTS_ENV: &str = "LIXRAY_PERF_SPANS";
const OTEL_TELEMETRY_FILTER: &str = "lixray=info,lix=info,lix_sql=info";

#[derive(Clone, Debug, Default)]
/// Tracks SQL spans that have started under a protocol request but have not closed.
pub struct InFlightSqlRegistry {
    inner: Arc<Mutex<InFlightSqlState>>,
}

#[derive(Debug, Default)]
struct InFlightSqlState {
    request_by_sql_span: HashMap<tracing::span::Id, tracing::span::Id>,
    activity_by_request:
        HashMap<tracing::span::Id, HashMap<tracing::span::Id, InFlightSqlActivity>>,
    errors_by_request: HashMap<tracing::span::Id, Vec<InFlightSqlActivity>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct InFlightSqlActivity {
    pub(crate) operation: Option<String>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) execution_kind: Option<String>,
    pub(crate) batch_index: Option<u64>,
    pub(crate) error_code: Option<String>,
}

impl InFlightSqlRegistry {
    pub(crate) fn current(&self) -> Vec<InFlightSqlActivity> {
        let Some(request_span_id) = tracing::Span::current().id() else {
            return Vec::new();
        };
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut activities = state
            .activity_by_request
            .get(&request_span_id)
            .map(|activities| activities.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        activities.sort_by_key(|activity| activity.batch_index);
        activities
    }

    /// Drains completed SQL failures for the current protocol request.
    ///
    /// Lix SQL spans finish before the protocol response is returned. Keeping
    /// only their redacted fingerprint and stable error code until this call
    /// lets the HTTP boundary log actionable failures without buffering or
    /// parsing request/response bodies.
    pub(crate) fn take_errors(&self) -> Vec<InFlightSqlActivity> {
        let Some(request_span_id) = tracing::Span::current().id() else {
            return Vec::new();
        };
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .errors_by_request
            .remove(&request_span_id)
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug)]
struct InFlightSqlLayer {
    registry: InFlightSqlRegistry,
}

impl<S> Layer<S> for InFlightSqlLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(
        &self,
        attributes: &Attributes<'_>,
        id: &tracing::span::Id,
        context: LayerContext<'_, S>,
    ) {
        if attributes.metadata().name() != "lix.sql.query" {
            return;
        }
        let Some(sql_span) = context.span(id) else {
            return;
        };
        let mut ancestor = sql_span.parent();
        let mut request_span_id = None;
        while let Some(span) = ancestor {
            if span.metadata().name() == "lix.protocol.request" {
                request_span_id = Some(span.id().clone());
                break;
            }
            ancestor = span.parent();
        }
        let Some(request_span_id) = request_span_id else {
            return;
        };

        let mut activity = InFlightSqlActivity::default();
        attributes.record(&mut SqlActivityVisitor(&mut activity));
        let mut state = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .request_by_sql_span
            .insert(id.clone(), request_span_id.clone());
        state
            .activity_by_request
            .entry(request_span_id)
            .or_default()
            .insert(id.clone(), activity);
    }

    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        _context: LayerContext<'_, S>,
    ) {
        let mut state = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(request_span_id) = state.request_by_sql_span.get(id).cloned() else {
            return;
        };
        let Some(activity) = state
            .activity_by_request
            .get_mut(&request_span_id)
            .and_then(|activities| activities.get_mut(id))
        else {
            return;
        };
        values.record(&mut SqlActivityVisitor(activity));
    }

    fn on_close(&self, id: tracing::span::Id, context: LayerContext<'_, S>) {
        let mut state = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if context
            .span(&id)
            .is_some_and(|span| span.metadata().name() == "lix.protocol.request")
        {
            state.activity_by_request.remove(&id);
            state.errors_by_request.remove(&id);
            state
                .request_by_sql_span
                .retain(|_, request_span_id| request_span_id != &id);
            return;
        }
        let Some(request_span_id) = state.request_by_sql_span.remove(&id) else {
            return;
        };
        let (activity, remove_request) = state
            .activity_by_request
            .get_mut(&request_span_id)
            .map_or((None, false), |activities| {
                let activity = activities.remove(&id);
                (activity, activities.is_empty())
            });
        if remove_request {
            state.activity_by_request.remove(&request_span_id);
        }
        if let Some(activity) = activity {
            if activity.error_code.is_some() {
                state
                    .errors_by_request
                    .entry(request_span_id)
                    .or_default()
                    .push(activity);
            }
        }
    }
}

struct SqlActivityVisitor<'a>(&'a mut InFlightSqlActivity);

impl Visit for SqlActivityVisitor<'_> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        match field.name() {
            "db.operation.name" => self.0.operation = Some(value.to_string()),
            "lix.sql.fingerprint" => self.0.fingerprint = Some(value.to_string()),
            "lix.execution.kind" => self.0.execution_kind = Some(value.to_string()),
            "error.type" => self.0.error_code = Some(value.to_string()),
            _ => {}
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "lix.batch.index" {
            self.0.batch_index = Some(value);
        }
    }

    fn record_debug(&mut self, _field: &tracing::field::Field, _value: &dyn std::fmt::Debug) {}
}

/// Host-owned telemetry runtime. Lix receives only the vendor-neutral sink;
/// exporters, filtering, and PostHog projections remain server concerns.
pub(crate) struct TelemetryRuntime {
    pub(crate) trace_provider: SdkTracerProvider,
    pub(crate) in_flight_sql: InFlightSqlRegistry,
    pub(crate) lix_sink: Arc<dyn TelemetrySink>,
}

/// Installs server tracing and builds the explicitly configured Lix sink.
pub(crate) fn init() -> TelemetryRuntime {
    let provider = match provider_from_env() {
        Ok(provider) => provider,
        Err(error) => {
            eprintln!(
                "failed to initialize PostHog telemetry; continuing without export: {error:#}"
            );
            SdkTracerProvider::builder().build()
        }
    };
    let tracer = provider.tracer("lix-server");
    let telemetry_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let span_events = if perf_span_events_enabled() {
        FmtSpan::CLOSE
    } else {
        FmtSpan::NONE
    };
    let in_flight_sql = InFlightSqlRegistry::default();
    let log_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let telemetry_filter = EnvFilter::new(OTEL_TELEMETRY_FILTER);
    let subscriber = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_span_events(span_events)
                .with_filter(log_filter),
        )
        .with(telemetry_layer.with_filter(telemetry_filter))
        .with(InFlightSqlLayer {
            registry: in_flight_sql.clone(),
        });
    let dispatch = tracing::Dispatch::new(subscriber);
    tracing::dispatcher::set_global_default(dispatch.clone())
        .expect("install the lix-server tracing dispatch once");

    TelemetryRuntime {
        trace_provider: provider,
        in_flight_sql,
        lix_sink: Arc::new(OpenTelemetryTracingSink::new(dispatch)),
    }
}

fn perf_span_events_enabled() -> bool {
    env::var(PERF_SPAN_EVENTS_ENV)
        .ok()
        .is_some_and(|value| matches!(value.trim(), "1" | "true"))
}

fn provider_from_env() -> Result<SdkTracerProvider> {
    let Some(config) = posthog_config_from_env()? else {
        return Ok(SdkTracerProvider::builder().build());
    };
    let endpoint = format!("{}/i/v1/traces", config.host.trim_end_matches('/'));
    let exporter = build_posthog_exporter(endpoint, &config.token)?;
    let resource = Resource::builder()
        .with_service_name("lix-server")
        .with_attributes([
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new("deployment.environment.name", "production"),
        ])
        .build();
    let otlp = batch_span_processor(exporter);
    let ai_spans = batch_span_processor(PostHogAiSpanExporter::new(config));
    Ok(SdkTracerProvider::builder()
        .with_resource(resource)
        .with_span_processor(otlp)
        .with_span_processor(ai_spans)
        .build())
}

#[derive(Clone)]
struct PostHogConfig {
    token: String,
    host: String,
}

fn posthog_config_from_env() -> Result<Option<PostHogConfig>> {
    if env::var("POSTHOG_ENVIRONMENT").ok().as_deref() != Some("production") {
        return Ok(None);
    }
    let Some(token) = optional_nonempty_env("POSTHOG_PROJECT_TOKEN")? else {
        return Ok(None);
    };
    let host =
        optional_nonempty_env("POSTHOG_HOST")?.unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_string());
    Ok(Some(PostHogConfig { token, host }))
}

fn build_posthog_exporter(
    endpoint: String,
    token: &str,
) -> Result<opentelemetry_otlp::SpanExporter> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(5))
        .with_compression(Compression::Gzip)
        .with_headers(HashMap::from([(
            "Authorization".to_string(),
            format!("Bearer {token}"),
        )]))
        .build()
        .context("build OTLP HTTP exporter")?;
    Ok(exporter)
}

fn batch_span_processor<T>(exporter: T) -> BatchSpanProcessor<TokioBatchRuntime>
where
    T: SpanExporter + 'static,
{
    BatchSpanProcessor::builder(exporter, runtime::Tokio)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_export_timeout(Duration::from_secs(5))
                .build(),
        )
        .build()
}

type TokioBatchRuntime = runtime::Tokio;

const ANONYMOUS_ACCOUNT_ID: &str = lix_sdk::ANONYMOUS_ACCOUNT_ID;
const DEMO_ACCOUNT_ID: &str = "lixray-demo";
const AI_SPAN_EVENT: &str = "$ai_span";
const LIX_REPOSITORY_OPENED_SPAN_NAME: &str = "lix.repository.opened";

#[derive(Clone, Debug, PartialEq, Eq)]
struct LixRepositoryOpenedAiSpan {
    distinct_id: String,
    lix_id: String,
    branch_id: Option<String>,
    repository_id: Option<String>,
    organization_id: Option<String>,
    environment: String,
    source: Option<String>,
    trace_id: String,
    span_id: String,
}

/// PostHog-specific projection of completed OpenTelemetry spans. The batch
/// processor invokes this exporter off the repository/session critical path.
#[derive(Debug)]
struct PostHogAiSpanExporter {
    client: reqwest::Client,
    token: String,
    endpoint: String,
}

impl PostHogAiSpanExporter {
    fn new(config: PostHogConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token: config.token,
            endpoint: format!("{}/i/v0/e/", config.host.trim_end_matches('/')),
        }
    }
}

impl SpanExporter for PostHogAiSpanExporter {
    fn export(
        &self,
        batch: Vec<SpanData>,
    ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
        let client = self.client.clone();
        let token = self.token.clone();
        let endpoint = self.endpoint.clone();
        let events = batch
            .iter()
            .filter_map(repository_opened_ai_span)
            .collect::<Vec<_>>();
        async move {
            for event in events {
                let body = serde_json::json!({
                    "api_key": token,
                    "event": AI_SPAN_EVENT,
                    "distinct_id": event.distinct_id,
                    "properties": ai_span_properties(&event),
                });
                let response =
                    client
                        .post(&endpoint)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|error| {
                            OTelSdkError::InternalFailure(format!(
                                "send lix.repository.opened $ai_span: {error}"
                            ))
                        })?;
                if !response.status().is_success() {
                    return Err(OTelSdkError::InternalFailure(format!(
                        "send lix.repository.opened $ai_span: HTTP {}",
                        response.status()
                    )));
                }
            }
            Ok(())
        }
    }
}

fn repository_opened_ai_span(span: &SpanData) -> Option<LixRepositoryOpenedAiSpan> {
    if span.name != LIX_REPOSITORY_OPENED_SPAN_NAME {
        return None;
    }
    let lix_id = span_string_attribute(span, "lix.id")?.to_owned();
    let distinct_id = identified_distinct_id(span_string_attribute(span, "lix.account_id"))?;
    Some(LixRepositoryOpenedAiSpan {
        distinct_id: distinct_id.to_owned(),
        repository_id: Some(lix_id.clone()),
        lix_id,
        branch_id: span_string_attribute(span, "lix.branch_id").map(ToOwned::to_owned),
        organization_id: None,
        environment: "production".to_string(),
        source: Some("server".to_string()),
        trace_id: span.span_context.trace_id().to_string(),
        span_id: span.span_context.span_id().to_string(),
    })
}

fn identified_distinct_id(account_id: Option<&str>) -> Option<&str> {
    let distinct_id = account_id?.trim();
    if distinct_id.is_empty()
        || distinct_id == ANONYMOUS_ACCOUNT_ID
        || distinct_id == DEMO_ACCOUNT_ID
    {
        None
    } else {
        Some(distinct_id)
    }
}

fn span_string_attribute<'a>(span: &'a SpanData, key: &str) -> Option<&'a str> {
    span.attributes.iter().find_map(|attribute| {
        if attribute.key.as_str() == key {
            match &attribute.value {
                Value::String(value) if !value.as_str().is_empty() => Some(value.as_str()),
                _ => None,
            }
        } else {
            None
        }
    })
}

fn ai_span_properties(
    event: &LixRepositoryOpenedAiSpan,
) -> serde_json::Map<String, serde_json::Value> {
    let mut properties = serde_json::Map::new();
    properties.insert(
        "$ai_span_name".into(),
        serde_json::Value::String(LIX_REPOSITORY_OPENED_SPAN_NAME.to_string()),
    );
    properties.insert(
        "$ai_trace_id".into(),
        serde_json::Value::String(event.trace_id.clone()),
    );
    properties.insert(
        "$ai_span_id".into(),
        serde_json::Value::String(event.span_id.clone()),
    );
    properties.insert(
        "lix_id".into(),
        serde_json::Value::String(event.lix_id.clone()),
    );
    if let Some(branch_id) = &event.branch_id {
        properties.insert(
            "branch_id".into(),
            serde_json::Value::String(branch_id.clone()),
        );
    }
    if let Some(repository_id) = &event.repository_id {
        properties.insert(
            "repository_id".into(),
            serde_json::Value::String(repository_id.clone()),
        );
    }
    if let Some(organization_id) = &event.organization_id {
        properties.insert(
            "organization_id".into(),
            serde_json::Value::String(organization_id.clone()),
        );
    }
    properties.insert(
        "environment".into(),
        serde_json::Value::String(event.environment.clone()),
    );
    if let Some(source) = &event.source {
        properties.insert("source".into(), serde_json::Value::String(source.clone()));
    }
    properties
}

fn optional_nonempty_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => anyhow::bail!("{name} must not be empty when set"),
        Ok(value) => Ok(Some(value.trim().to_string())),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{header::CONTENT_ENCODING, HeaderMap, StatusCode},
        routing::post,
        Router,
    };
    use opentelemetry::trace::{Span as _, Tracer as _};
    use opentelemetry_sdk::{
        error::{OTelSdkError, OTelSdkResult},
        trace::SpanData,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    };

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn exporter_is_disabled_outside_production() {
        let _guard = env_lock().lock().unwrap();
        env::remove_var("POSTHOG_ENVIRONMENT");
        env::set_var("POSTHOG_PROJECT_TOKEN", "test-token");
        assert!(posthog_config_from_env().unwrap().is_none());
        env::remove_var("POSTHOG_PROJECT_TOKEN");
    }

    #[test]
    fn exporter_is_disabled_without_a_token() {
        let _guard = env_lock().lock().unwrap();
        env::set_var("POSTHOG_ENVIRONMENT", "production");
        env::remove_var("POSTHOG_PROJECT_TOKEN");
        assert!(posthog_config_from_env().unwrap().is_none());
        env::remove_var("POSTHOG_ENVIRONMENT");
    }

    #[test]
    fn performance_span_close_events_are_opt_in() {
        let _guard = env_lock().lock().unwrap();
        env::remove_var(PERF_SPAN_EVENTS_ENV);
        assert!(!perf_span_events_enabled());
        env::set_var(PERF_SPAN_EVENTS_ENV, "0");
        assert!(!perf_span_events_enabled());
        env::set_var(PERF_SPAN_EVENTS_ENV, "1");
        assert!(perf_span_events_enabled());
        env::set_var(PERF_SPAN_EVENTS_ENV, "true");
        assert!(perf_span_events_enabled());
        env::remove_var(PERF_SPAN_EVENTS_ENV);
    }

    #[test]
    fn in_flight_sql_survives_until_the_unfinished_span_closes() {
        let in_flight_sql = InFlightSqlRegistry::default();
        let subscriber = tracing_subscriber::registry().with(InFlightSqlLayer {
            registry: in_flight_sql.clone(),
        });
        tracing::subscriber::with_default(subscriber, || {
            let request = tracing::info_span!("lix.protocol.request");
            request.in_scope(|| {
                let sql = tracing::info_span!(
                    target: "lix_sql",
                    "lix.sql.query",
                    "db.operation.name" = tracing::field::Empty,
                    "lix.sql.fingerprint" = tracing::field::Empty,
                    "lix.execution.kind" = tracing::field::Empty,
                    "lix.batch.index" = tracing::field::Empty,
                    "db.query.text" = tracing::field::Empty,
                );
                sql.record("db.operation.name", "SELECT");
                sql.record("lix.sql.fingerprint", "safe-fingerprint");
                sql.record("lix.execution.kind", "query");
                sql.record("lix.batch.index", 2_u64);
                sql.record("db.query.text", "SELECT secret FROM private_table");

                assert_eq!(
                    in_flight_sql.current(),
                    vec![InFlightSqlActivity {
                        operation: Some("SELECT".to_string()),
                        fingerprint: Some("safe-fingerprint".to_string()),
                        execution_kind: Some("query".to_string()),
                        batch_index: Some(2),
                        error_code: None,
                    }]
                );
                assert!(!format!("{:?}", in_flight_sql.current()).contains("secret"));

                drop(sql);
                assert!(in_flight_sql.current().is_empty());
            });
        });
    }

    #[test]
    fn completed_sql_failures_retain_only_safe_diagnostics_until_drained() {
        let in_flight_sql = InFlightSqlRegistry::default();
        let subscriber = tracing_subscriber::registry().with(InFlightSqlLayer {
            registry: in_flight_sql.clone(),
        });
        tracing::subscriber::with_default(subscriber, || {
            let request = tracing::info_span!("lix.protocol.request");
            request.in_scope(|| {
                let sql = tracing::info_span!(
                    target: "lix_sql",
                    "lix.sql.query",
                    "db.operation.name" = tracing::field::Empty,
                    "lix.sql.fingerprint" = tracing::field::Empty,
                    "lix.execution.kind" = tracing::field::Empty,
                    "lix.batch.index" = tracing::field::Empty,
                    "db.query.text" = tracing::field::Empty,
                    "error.type" = tracing::field::Empty,
                );
                sql.record("db.operation.name", "SELECT");
                sql.record("lix.sql.fingerprint", "safe-fingerprint");
                sql.record("lix.execution.kind", "execute");
                sql.record("lix.batch.index", 3_u64);
                sql.record("db.query.text", "SELECT secret FROM private_table");
                sql.record("error.type", "LIX_ERROR_UNKNOWN_COLUMN");
                drop(sql);

                assert!(in_flight_sql.current().is_empty());
                let failures = in_flight_sql.take_errors();
                assert_eq!(
                    failures,
                    vec![InFlightSqlActivity {
                        operation: Some("SELECT".to_string()),
                        fingerprint: Some("safe-fingerprint".to_string()),
                        execution_kind: Some("execute".to_string()),
                        batch_index: Some(3),
                        error_code: Some("LIX_ERROR_UNKNOWN_COLUMN".to_string()),
                    }]
                );
                assert!(!format!("{failures:?}").contains("secret"));
                assert!(in_flight_sql.take_errors().is_empty());
            });
        });
    }

    #[test]
    fn completed_successful_sql_is_not_retained_as_a_failure() {
        let in_flight_sql = InFlightSqlRegistry::default();
        let subscriber = tracing_subscriber::registry().with(InFlightSqlLayer {
            registry: in_flight_sql.clone(),
        });
        tracing::subscriber::with_default(subscriber, || {
            let request = tracing::info_span!("lix.protocol.request");
            request.in_scope(|| {
                let sql = tracing::info_span!(
                    target: "lix_sql",
                    "lix.sql.query",
                    "lix.sql.fingerprint" = "safe-fingerprint",
                    "error.type" = tracing::field::Empty,
                );
                drop(sql);

                assert!(in_flight_sql.take_errors().is_empty());
            });
        });
    }

    #[test]
    fn exporter_gzip_compresses_http_requests() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (request_sender, mut request_receiver) = tokio::sync::mpsc::unbounded_channel();
            let app = Router::new().route(
                "/i/v1/traces",
                post(move |headers: HeaderMap, body: Bytes| {
                    let request_sender = request_sender.clone();
                    async move {
                        let _ = request_sender.send((headers, body));
                        StatusCode::OK
                    }
                }),
            );
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });

            let exporter =
                build_posthog_exporter(format!("http://{address}/i/v1/traces"), "test-token")
                    .unwrap();
            let provider = SdkTracerProvider::builder()
                .with_resource(Resource::builder().build())
                .with_span_processor(batch_span_processor(exporter))
                .build();
            let tracer = provider.tracer("compression-test");
            let mut span = tracer.start("gzip-regression");
            span.end();

            let flush_provider = provider.clone();
            let flush_result = tokio::task::spawn_blocking(move || flush_provider.force_flush())
                .await
                .unwrap();
            assert!(flush_result.is_ok());

            let (headers, body) =
                tokio::time::timeout(Duration::from_secs(5), request_receiver.recv())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(headers[CONTENT_ENCODING], "gzip");
            assert_eq!(body.get(..2), Some([0x1f, 0x8b].as_slice()));

            let shutdown_result = tokio::task::spawn_blocking(move || provider.shutdown())
                .await
                .unwrap();
            assert!(shutdown_result.is_ok());
            server.abort();
        });
    }

    #[derive(Debug)]
    struct TokioRuntimeExporter {
        exported: Arc<AtomicBool>,
    }

    impl SpanExporter for TokioRuntimeExporter {
        fn export(
            &self,
            _batch: Vec<SpanData>,
        ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
            let exported = Arc::clone(&self.exported);
            async move {
                if tokio::runtime::Handle::try_current().is_err() {
                    return Err(OTelSdkError::InternalFailure(
                        "span export ran outside Tokio".to_string(),
                    ));
                }
                exported.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exporter_runs_on_the_tokio_runtime() {
        let exported = Arc::new(AtomicBool::new(false));
        let provider = SdkTracerProvider::builder()
            .with_resource(Resource::builder().build())
            .with_span_processor(batch_span_processor(TokioRuntimeExporter {
                exported: Arc::clone(&exported),
            }))
            .build();
        let span_provider = provider.clone();
        tokio::task::spawn_blocking(move || {
            let tracer = span_provider.tracer("telemetry-test");
            let mut span = tracer.start("runtime-regression");
            span.end();
        })
        .await
        .unwrap();

        let flush_provider = provider.clone();
        let flush_result = tokio::task::spawn_blocking(move || flush_provider.force_flush())
            .await
            .unwrap();
        let shutdown_result = tokio::task::spawn_blocking(move || provider.shutdown())
            .await
            .unwrap();

        assert!(flush_result.is_ok());
        assert!(exported.load(Ordering::SeqCst));
        assert!(shutdown_result.is_ok());
    }

    #[derive(Clone, Debug)]
    struct RecordingSpanExporter(Arc<Mutex<Vec<SpanData>>>);

    impl SpanExporter for RecordingSpanExporter {
        fn export(
            &self,
            batch: Vec<SpanData>,
        ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
            let spans = Arc::clone(&self.0);
            async move {
                spans.lock().unwrap().extend(batch);
                Ok(())
            }
        }
    }

    fn production_shape_lix_sink(
        spans: Arc<Mutex<Vec<SpanData>>>,
    ) -> (SdkTracerProvider, Arc<dyn TelemetrySink>) {
        let provider = SdkTracerProvider::builder()
            .with_span_processor(batch_span_processor(RecordingSpanExporter(spans)))
            .build();
        let tracer = provider.tracer("lix-server-test");
        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::sink)
                    .with_filter(EnvFilter::new("lixray=info,lix_sql=info")),
            )
            .with(
                tracing_opentelemetry::layer()
                    .with_tracer(tracer)
                    .with_filter(EnvFilter::new(OTEL_TELEMETRY_FILTER)),
            );
        let dispatch = tracing::Dispatch::new(subscriber);
        (provider, Arc::new(OpenTelemetryTracingSink::new(dispatch)))
    }

    async fn flush(provider: &SdkTracerProvider) {
        let provider = provider.clone();
        tokio::task::spawn_blocking(move || provider.force_flush())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn production_log_filter_still_projects_repository_opened_span() {
        let spans = Arc::new(Mutex::new(Vec::new()));
        let (provider, sink) = production_shape_lix_sink(Arc::clone(&spans));
        lix_sdk::bind_session(Some(&sink), "lix-1", "branch-1", Some("user-123"));
        flush(&provider).await;

        let spans = spans.lock().unwrap();
        let span = spans
            .iter()
            .find(|span| span.name == LIX_REPOSITORY_OPENED_SPAN_NAME)
            .expect("repository-opened span");
        let event = repository_opened_ai_span(span).expect("identified PostHog projection");
        assert_eq!(event.distinct_id, "user-123");
        assert_eq!(event.lix_id, "lix-1");
        assert_eq!(event.branch_id.as_deref(), Some("branch-1"));
        assert_eq!(event.repository_id.as_deref(), Some("lix-1"));
        assert_eq!(event.organization_id, None);
        assert_eq!(event.environment, "production");
        assert_eq!(event.source.as_deref(), Some("server"));
        let properties = ai_span_properties(&event);
        assert_eq!(
            properties
                .get("$ai_span_name")
                .and_then(|value| value.as_str()),
            Some(LIX_REPOSITORY_OPENED_SPAN_NAME)
        );
        assert!(!properties.contains_key("$ai_latency"));
        assert_ne!(AI_SPAN_EVENT, "repository_opened");
        assert_ne!(AI_SPAN_EVENT, "lixray_repository_opened");
        assert_ne!(AI_SPAN_EVENT, "webapp_repository_opened");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protocol_engine_open_does_not_project_a_repository_opened_span() {
        let spans = Arc::new(Mutex::new(Vec::new()));
        let (provider, sink) = production_shape_lix_sink(Arc::clone(&spans));
        let _protocol = lix_sdk::open_lix()
            .with_telemetry(Arc::clone(&sink))
            .serve()
            .await
            .expect("serve protocol engine");
        flush(&provider).await;
        assert!(spans
            .lock()
            .unwrap()
            .iter()
            .all(|span| repository_opened_ai_span(span).is_none()));

        lix_sdk::bind_session(Some(&sink), "lix-1", "branch-1", Some("user-123"));
        flush(&provider).await;
        assert_eq!(
            spans
                .lock()
                .unwrap()
                .iter()
                .filter_map(repository_opened_ai_span)
                .count(),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn anonymous_and_demo_binds_are_not_projected_to_posthog() {
        let spans = Arc::new(Mutex::new(Vec::new()));
        let (provider, sink) = production_shape_lix_sink(Arc::clone(&spans));
        lix_sdk::bind_session(
            Some(&sink),
            "lix-1",
            "branch-1",
            Some(lix_sdk::ANONYMOUS_ACCOUNT_ID),
        );
        lix_sdk::bind_session(Some(&sink), "lix-1", "branch-1", Some("lixray-demo"));
        lix_sdk::bind_session(Some(&sink), "lix-1", "branch-1", None);
        flush(&provider).await;
        assert!(spans
            .lock()
            .unwrap()
            .iter()
            .all(|span| repository_opened_ai_span(span).is_none()));
    }

    #[test]
    fn missing_or_invalid_posthog_config_does_not_prevent_startup() {
        let _guard = env_lock().lock().unwrap();
        env::remove_var("POSTHOG_ENVIRONMENT");
        env::set_var("POSTHOG_PROJECT_TOKEN", "test-token");
        assert!(posthog_config_from_env().unwrap().is_none());

        env::set_var("POSTHOG_ENVIRONMENT", "production");
        env::remove_var("POSTHOG_PROJECT_TOKEN");
        assert!(posthog_config_from_env().unwrap().is_none());

        env::set_var("POSTHOG_PROJECT_TOKEN", "   ");
        assert!(posthog_config_from_env().is_err());

        env::remove_var("POSTHOG_ENVIRONMENT");
        env::remove_var("POSTHOG_PROJECT_TOKEN");
    }
}
