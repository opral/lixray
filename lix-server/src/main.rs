use anyhow::Context;
use lixray::{router, Config, WorkspaceRuntimeManager};
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();

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
    axum::serve(listener, router(manager, internal_token))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve HTTP")
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
