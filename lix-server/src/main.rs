use anyhow::Context;
use lixray::{router, Config, WorkspaceRuntimeManager};
use tokio::net::TcpListener;

mod telemetry;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let trace_provider = telemetry::init();

    let config = Config::from_env()?;
    let listener = TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("bind {}", config.bind_addr))?;
    let manager = WorkspaceRuntimeManager::new(&config)?;
    let internal_token = config.internal_token.clone();
    tracing::info!(
        addr = %config.bind_addr,
        max_open_workspaces = config.max_open_workspaces,
        internal_auth = internal_token.is_some(),
        "lix workspace service ready"
    );
    let result = axum::serve(
        listener,
        router(manager, internal_token, config.protocol_timeout),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("serve HTTP");
    if let Some(provider) = trace_provider {
        match tokio::task::spawn_blocking(move || provider.shutdown()).await {
            Ok(Err(error)) => tracing::warn!(%error, "failed to flush traces during shutdown"),
            Err(error) => tracing::warn!(%error, "failed to join trace shutdown task"),
            Ok(Ok(())) => {}
        }
    }
    result
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
