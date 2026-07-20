use anyhow::{Context, Result};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    runtime,
    trace::{
        span_processor_with_async_runtime::BatchSpanProcessor, BatchConfigBuilder,
        SdkTracerProvider, SpanExporter,
    },
    Resource,
};
use std::{collections::HashMap, env, time::Duration};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

pub(crate) fn init() -> Option<SdkTracerProvider> {
    let provider = match posthog_provider_from_env() {
        Ok(provider) => provider,
        Err(error) => {
            eprintln!(
                "failed to initialize PostHog trace export; continuing without it: {error:#}"
            );
            None
        }
    };
    let telemetry_layer = provider.as_ref().map(|provider| {
        let tracer = provider.tracer("lix-server");
        tracing_opentelemetry::layer().with_tracer(tracer)
    });

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .with(telemetry_layer)
        .init();

    provider
}

fn posthog_provider_from_env() -> Result<Option<SdkTracerProvider>> {
    if env::var("POSTHOG_ENVIRONMENT").ok().as_deref() != Some("production") {
        return Ok(None);
    }
    let Some(token) = optional_nonempty_env("POSTHOG_PROJECT_TOKEN")? else {
        return Ok(None);
    };
    let host =
        optional_nonempty_env("POSTHOG_HOST")?.unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_string());
    let endpoint = format!("{}/i/v1/traces", host.trim_end_matches('/'));
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(5))
        .with_headers(HashMap::from([(
            "Authorization".to_string(),
            format!("Bearer {token}"),
        )]))
        .build()
        .context("build OTLP HTTP exporter")?;
    let resource = Resource::builder()
        .with_service_name("lix-server")
        .with_attributes([
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new("deployment.environment.name", "production"),
        ])
        .build();
    Ok(Some(provider_with_tokio_batch_exporter(exporter, resource)))
}

fn provider_with_tokio_batch_exporter<T>(exporter: T, resource: Resource) -> SdkTracerProvider
where
    T: SpanExporter + 'static,
{
    let processor = BatchSpanProcessor::builder(exporter, runtime::Tokio)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_export_timeout(Duration::from_secs(5))
                .build(),
        )
        .build();
    SdkTracerProvider::builder()
        .with_resource(resource)
        .with_span_processor(processor)
        .build()
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
        assert!(posthog_provider_from_env().unwrap().is_none());
        env::remove_var("POSTHOG_PROJECT_TOKEN");
    }

    #[test]
    fn exporter_is_disabled_without_a_token() {
        let _guard = env_lock().lock().unwrap();
        env::set_var("POSTHOG_ENVIRONMENT", "production");
        env::remove_var("POSTHOG_PROJECT_TOKEN");
        assert!(posthog_provider_from_env().unwrap().is_none());
        env::remove_var("POSTHOG_ENVIRONMENT");
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
        let provider = provider_with_tokio_batch_exporter(
            TokioRuntimeExporter {
                exported: Arc::clone(&exported),
            },
            Resource::builder().build(),
        );
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
}
