use crate::Config;
use anyhow::{Context, Result};
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
#[cfg(test)]
use object_store::memory::InMemory;
use object_store::{aws::AmazonS3Builder, ClientOptions, ObjectStore, RetryConfig};
#[cfg(test)]
use object_store::{path::Path as ObjectPath, ClientConfigKey, ObjectStoreExt};
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Handle;
use tokio::sync::{Mutex, OnceCell};
use tracing::info;

// SlateDB's disk cache fetches object-store data in 4 MiB parts. A 15 second
// request timeout still permits a part to arrive at roughly 270 KiB/s, while a
// single stalled request can no longer occupy a lix runtime for the
// object_store default three-minute retry budget. One retry preserves recovery
// from a transient slow path without turning an interactive request into a
// multi-minute wait.
const S3_REQUEST_BUDGET: S3RequestBudget = S3RequestBudget {
    request_timeout: Duration::from_secs(15),
    connect_timeout: Duration::from_secs(3),
    retry_timeout: Duration::from_secs(30),
    max_retries: 1,
};

#[derive(Clone, Copy)]
struct S3RequestBudget {
    request_timeout: Duration,
    connect_timeout: Duration,
    retry_timeout: Duration,
    max_retries: usize,
}

pub(crate) struct LixService {
    protocol: lix_server_protocol::LixProtocolServer<SlateDB>,
}

struct LixRuntime {
    state: Mutex<LixRuntimeState>,
}

enum LixRuntimeState {
    Active(Arc<LixService>),
    Recovering,
}

pub struct LixRuntimeManager {
    backend: StorageBackend,
    max_open_lixes: usize,
    max_sessions_per_lix: usize,
    state: Mutex<ManagerState>,
}

#[derive(Clone)]
enum StorageBackend {
    #[cfg(test)]
    Memory { object_store: Arc<dyn ObjectStore> },
    S3 {
        object_store: Arc<dyn ObjectStore>,
        prefix: String,
        cache: SlateDBCacheOptions,
    },
}

#[derive(Default)]
struct ManagerState {
    entries: HashMap<String, RuntimeEntry>,
    clock: u64,
}

struct RuntimeEntry {
    runtime: Arc<OnceCell<Arc<LixRuntime>>>,
    last_used: u64,
}

#[derive(Debug)]
pub(crate) enum LixRuntimeError {
    InvalidId,
    AtCapacity { max: usize },
    Recovering,
    Open(anyhow::Error),
}

impl LixRuntimeManager {
    pub fn new(config: &Config) -> Result<Arc<Self>> {
        let storage = &config.storage;
        let request_budget = S3_REQUEST_BUDGET;
        let object_store: Arc<dyn ObjectStore> = Arc::new(
            AmazonS3Builder::new()
                .with_endpoint(&storage.endpoint)
                .with_bucket_name(&storage.bucket)
                .with_access_key_id(&storage.access_key_id)
                .with_secret_access_key(&storage.secret_access_key)
                .with_region(&storage.region)
                .with_virtual_hosted_style_request(false)
                .with_client_options(s3_client_options(request_budget))
                .with_retry(s3_retry_config(request_budget))
                .with_allow_http(storage.allow_http)
                .build()
                .context("build S3 object store")?,
        );
        let backend = StorageBackend::S3 {
            object_store,
            prefix: storage.prefix.clone(),
            cache: SlateDBCacheOptions {
                root_folder: storage.cache.root_folder.clone(),
                max_disk_cache_bytes: per_lix_usize(
                    storage.cache.max_disk_cache_bytes,
                    config.max_open_lixes,
                ),
                block_cache_bytes: per_lix_u64(
                    storage.cache.block_cache_bytes,
                    config.max_open_lixes,
                ),
                metadata_cache_bytes: per_lix_u64(
                    storage.cache.metadata_cache_bytes,
                    config.max_open_lixes,
                ),
            },
        };

        Ok(Arc::new(Self {
            backend,
            max_open_lixes: config.max_open_lixes,
            max_sessions_per_lix: config.max_sessions_per_lix,
            state: Mutex::new(ManagerState::default()),
        }))
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory(max_open_lixes: usize) -> Arc<Self> {
        Self::new_in_memory_with_session_capacity(max_open_lixes, 64)
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory_with_session_capacity(
        max_open_lixes: usize,
        max_sessions_per_lix: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            backend: StorageBackend::Memory {
                object_store: Arc::new(InMemory::new()),
            },
            max_open_lixes,
            max_sessions_per_lix,
            state: Mutex::new(ManagerState::default()),
        })
    }

    pub(crate) async fn get(
        self: &Arc<Self>,
        lix_id: &str,
    ) -> std::result::Result<Arc<LixService>, LixRuntimeError> {
        if !valid_lix_id(lix_id) {
            return Err(LixRuntimeError::InvalidId);
        }

        let runtime_cell = {
            let mut state = self.state.lock().await;
            state.clock = state.clock.wrapping_add(1);
            let now = state.clock;
            if let Some(entry) = state.entries.get_mut(lix_id) {
                entry.last_used = now;
                Arc::clone(&entry.runtime)
            } else {
                while state.entries.len() >= self.max_open_lixes {
                    let Some(eviction_id) = idle_lru_lix(&state.entries) else {
                        return Err(LixRuntimeError::AtCapacity {
                            max: self.max_open_lixes,
                        });
                    };
                    state.entries.remove(&eviction_id);
                    info!(lix_id = %eviction_id, "evicted idle lix runtime");
                }

                let runtime = Arc::new(OnceCell::new());
                state.entries.insert(
                    lix_id.to_string(),
                    RuntimeEntry {
                        runtime: Arc::clone(&runtime),
                        last_used: now,
                    },
                );
                runtime
            }
        };

        let result = runtime_cell
            .get_or_try_init(|| self.open_lix_for_handler(lix_id.to_string()))
            .await;
        match result {
            Ok(runtime) => {
                let runtime = Arc::clone(runtime);
                match runtime.acquire().await {
                    Some(service) => Ok(service),
                    None => Err(LixRuntimeError::Recovering),
                }
            }
            Err(error) => {
                let mut state = self.state.lock().await;
                if state
                    .entries
                    .get(lix_id)
                    .is_some_and(|entry| Arc::ptr_eq(&entry.runtime, &runtime_cell))
                {
                    state.entries.remove(lix_id);
                }
                Err(LixRuntimeError::Open(error))
            }
        }
    }

    async fn open_lix_for_handler(self: &Arc<Self>, lix_id: String) -> Result<Arc<LixRuntime>> {
        let manager = Arc::clone(self);
        let runtime = Handle::current();
        tokio::task::spawn_blocking(move || runtime.block_on(manager.open_lix(&lix_id)))
            .await
            .context("join lix runtime initialization")?
    }

    async fn open_lix(&self, lix_id: &str) -> Result<Arc<LixRuntime>> {
        let started = Instant::now();
        let storage = match &self.backend {
            #[cfg(test)]
            StorageBackend::Memory { object_store } => SlateDB::open_object_store_with_options(
                lix_id,
                Arc::clone(object_store),
                SlateDBObjectStoreOptions::default(),
            )
            .context("open in-memory Lix SlateDB storage")?,
            StorageBackend::S3 {
                object_store,
                prefix,
                cache,
            } => {
                let storage_prefix = if prefix.is_empty() {
                    lix_id.to_string()
                } else {
                    format!("{prefix}/{lix_id}")
                };
                let mut lix_cache = cache.clone();
                lix_cache.root_folder = lix_cache.root_folder.join(lix_id);
                SlateDB::open_object_store_with_options(
                    storage_prefix,
                    Arc::clone(object_store),
                    SlateDBObjectStoreOptions {
                        cache: Some(lix_cache),
                    },
                )
                .context("open cached S3-backed Lix SlateDB storage")?
            }
        };

        let protocol_root = Arc::new(
            lix_sdk::open_lix_with_telemetry(
                lix_sdk::OpenLixOptions::new(storage),
                Arc::new(lix_sdk::TracingTelemetrySink::new()),
            )
            .await
            .context("open Lix lix session for the canonical server protocol")?,
        );
        let protocol = lix_server_protocol::LixProtocolServer::with_options(
            protocol_root,
            lix_server_protocol::ProtocolServerOptions {
                max_sessions: self.max_sessions_per_lix,
                ..lix_server_protocol::ProtocolServerOptions::default()
            },
        )
        .context("configure canonical server protocol session capacity")?;
        info!(
            lix_id,
            elapsed_ms = elapsed_millis(started),
            "opened lix runtime"
        );
        Ok(Arc::new(LixRuntime::new(LixService { protocol })))
    }

    pub(crate) async fn recover(self: &Arc<Self>, lix_id: &str, service: &Arc<LixService>) {
        let runtime = {
            let state = self.state.lock().await;
            state
                .entries
                .get(lix_id)
                .and_then(|entry| entry.runtime.get())
                .cloned()
        };
        let Some(runtime) = runtime else {
            return;
        };
        let Some(draining_service) = runtime.begin_recovery(service).await else {
            return;
        };

        info!(lix_id, "lix runtime entering recovery");
        let manager = Arc::clone(self);
        let lix_id = lix_id.to_string();
        tokio::spawn(async move {
            let started = Instant::now();
            while Arc::strong_count(&draining_service) > 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }

            let close_result = close_drained_service(draining_service).await;
            match close_result {
                Ok(()) => info!(
                    lix_id,
                    elapsed_ms = elapsed_millis(started),
                    "closed recovered lix runtime"
                ),
                Err(error) => tracing::warn!(
                    lix_id,
                    elapsed_ms = elapsed_millis(started),
                    error = %error,
                    "released recovered lix runtime after close error"
                ),
            }
            manager.remove_recovered_runtime(&lix_id, &runtime).await;
        });
    }

    async fn remove_recovered_runtime(&self, lix_id: &str, expected_runtime: &Arc<LixRuntime>) {
        let mut state = self.state.lock().await;
        if state.entries.get(lix_id).is_some_and(|entry| {
            entry
                .runtime
                .get()
                .is_some_and(|runtime| Arc::ptr_eq(runtime, expected_runtime))
        }) {
            state.entries.remove(lix_id);
            info!(lix_id, "removed recovered lix runtime");
        }
    }

    #[cfg(test)]
    async fn cached_lix_count(&self) -> usize {
        self.state.lock().await.entries.len()
    }
}

impl LixService {
    pub(crate) fn protocol(&self) -> lix_server_protocol::LixProtocolServer<SlateDB> {
        self.protocol.clone()
    }

    async fn close(&self) -> Result<()> {
        self.protocol
            .close()
            .await
            .context("close Lix protocol sessions")
    }
}

impl LixRuntime {
    fn new(service: LixService) -> Self {
        Self {
            state: Mutex::new(LixRuntimeState::Active(Arc::new(service))),
        }
    }

    async fn acquire(&self) -> Option<Arc<LixService>> {
        let state = self.state.lock().await;
        match &*state {
            LixRuntimeState::Active(service) => Some(Arc::clone(service)),
            LixRuntimeState::Recovering => None,
        }
    }

    async fn begin_recovery(&self, expected_service: &Arc<LixService>) -> Option<Arc<LixService>> {
        let mut state = self.state.lock().await;
        match &*state {
            LixRuntimeState::Active(service) if Arc::ptr_eq(service, expected_service) => {
                let LixRuntimeState::Active(service) =
                    std::mem::replace(&mut *state, LixRuntimeState::Recovering)
                else {
                    unreachable!("matched active runtime state")
                };
                Some(service)
            }
            LixRuntimeState::Active(_) | LixRuntimeState::Recovering => None,
        }
    }

    fn is_idle(&self) -> bool {
        let Ok(state) = self.state.try_lock() else {
            return false;
        };
        matches!(
            &*state,
            LixRuntimeState::Active(service)
                if Arc::strong_count(service) == 1 && service.protocol.is_idle()
        )
    }
}

async fn close_drained_service(service: Arc<LixService>) -> Result<()> {
    let runtime = Handle::current();
    tokio::task::spawn_blocking(move || {
        let result = runtime.block_on(service.close());
        drop(service);
        result
    })
    .await
    .context("join recovered lix runtime close")?
}

impl fmt::Display for LixRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => write!(formatter, "invalid lix ID"),
            Self::AtCapacity { max } => write!(
                formatter,
                "lix service is at its capacity of {max} active runtimes"
            ),
            Self::Recovering => write!(formatter, "lix runtime is recovering"),
            Self::Open(error) => write!(formatter, "open lix runtime: {error:#}"),
        }
    }
}

impl Error for LixRuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Open(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

fn valid_lix_id(lix_id: &str) -> bool {
    !lix_id.is_empty()
        && lix_id.len() <= 128
        && lix_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn idle_lru_lix(entries: &HashMap<String, RuntimeEntry>) -> Option<String> {
    entries
        .iter()
        .filter(|(_, entry)| {
            Arc::strong_count(&entry.runtime) == 1
                && entry
                    .runtime
                    .get()
                    .is_some_and(|runtime| Arc::strong_count(runtime) == 1 && runtime.is_idle())
        })
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(lix_id, _)| lix_id.clone())
}

fn per_lix_usize(total: usize, lixes: usize) -> usize {
    total.checked_div(lixes).unwrap_or(0).max(1)
}

fn per_lix_u64(total: u64, lixes: usize) -> u64 {
    total
        .checked_div(u64::try_from(lixes).unwrap_or(u64::MAX))
        .unwrap_or(0)
        .max(1)
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn s3_client_options(budget: S3RequestBudget) -> ClientOptions {
    ClientOptions::new()
        .with_timeout(budget.request_timeout)
        .with_connect_timeout(budget.connect_timeout)
}

fn s3_retry_config(budget: S3RequestBudget) -> RetryConfig {
    RetryConfig {
        max_retries: budget.max_retries,
        retry_timeout: budget.retry_timeout,
        ..RetryConfig::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_manager(max_open_lixes: usize) -> Arc<LixRuntimeManager> {
        LixRuntimeManager::new_in_memory(max_open_lixes)
    }

    #[tokio::test]
    async fn concurrent_gets_share_one_runtime() {
        let manager = memory_manager(2);
        let (left, right) = tokio::join!(manager.get("lix-a"), manager.get("lix-a"));
        let left = left.expect("open left runtime");
        let right = right.expect("open right runtime");

        assert!(Arc::ptr_eq(&left, &right));
    }

    #[tokio::test]
    async fn evicts_the_least_recently_used_idle_runtime() {
        let manager = memory_manager(1);
        let first = manager.get("lix-a").await.expect("open first runtime");
        drop(first);
        let second = manager.get("lix-b").await.expect("open second runtime");

        assert_eq!(manager.cached_lix_count().await, 1);
        drop(second);
        let reopened = manager.get("lix-a").await.expect("reopen first runtime");
        assert_eq!(manager.cached_lix_count().await, 1);
        drop(reopened);
    }

    #[tokio::test]
    async fn active_service_lease_prevents_runtime_eviction() {
        let manager = memory_manager(1);
        let active = manager.get("lix-a").await.expect("open active runtime");

        assert!(matches!(
            manager.get("lix-b").await,
            Err(LixRuntimeError::AtCapacity { max: 1 })
        ));

        drop(active);
        manager
            .get("lix-b")
            .await
            .expect("evict runtime after its final service lease is released");
    }

    #[tokio::test]
    async fn live_protocol_session_prevents_runtime_eviction_between_requests() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt as _;

        let manager = memory_manager(1);
        let service = manager.get("lix-a").await.expect("open lix runtime");
        let handshake = lix_server_protocol::handler(service.protocol())
            .oneshot(
                Request::builder()
                    .uri("/lix/v1/")
                    .body(Body::empty())
                    .expect("handshake request"),
            )
            .await
            .expect("handshake response");
        assert_eq!(handshake.status(), axum::http::StatusCode::OK);
        drop(handshake);
        drop(service);

        assert!(matches!(
            manager.get("lix-b").await,
            Err(LixRuntimeError::AtCapacity { max: 1 })
        ));
    }

    #[tokio::test]
    async fn configured_protocol_capacity_keeps_128_agent_sessions_live() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt as _;

        const AGENTS: usize = 128;
        let manager = LixRuntimeManager::new_in_memory_with_session_capacity(1, AGENTS);
        let service = manager.get("lix-a").await.expect("open lix runtime");
        let protocol = lix_server_protocol::handler(service.protocol());
        let mut session_ids = Vec::with_capacity(AGENTS);

        for _ in 0..AGENTS {
            let response = protocol
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/lix/v1/")
                        .body(Body::empty())
                        .expect("handshake request"),
                )
                .await
                .expect("handshake response");
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("handshake body");
            let handshake: serde_json::Value =
                serde_json::from_slice(&body).expect("handshake JSON");
            session_ids.push(
                handshake["sessionId"]
                    .as_str()
                    .expect("session ID")
                    .to_string(),
            );
        }

        for session_id in &session_ids {
            let response = protocol
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/lix/v1/")
                        .header(lix_server_protocol::SESSION_ID_HEADER, session_id)
                        .body(Body::empty())
                        .expect("resume request"),
                )
                .await
                .expect("resume response");
            assert_eq!(response.status(), axum::http::StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn rejects_unsafe_lix_ids() {
        let manager = memory_manager(1);
        for lix_id in ["", "../escape", "contains/slash", "contains space"] {
            assert!(matches!(
                manager.get(lix_id).await,
                Err(LixRuntimeError::InvalidId)
            ));
        }
    }

    #[test]
    fn s3_request_policy_is_bounded() {
        let options = s3_client_options(S3_REQUEST_BUDGET);
        assert_eq!(
            options
                .get_config_value(&ClientConfigKey::Timeout)
                .as_deref(),
            Some("15s")
        );
        assert_eq!(
            options
                .get_config_value(&ClientConfigKey::ConnectTimeout)
                .as_deref(),
            Some("3s")
        );

        let retry = s3_retry_config(S3_REQUEST_BUDGET);
        assert_eq!(retry.max_retries, 1);
        assert_eq!(retry.retry_timeout, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn s3_request_policy_times_out_a_blackholed_head_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind blackhole listener");
        let endpoint = format!(
            "http://{}",
            listener.local_addr().expect("blackhole listener address")
        );
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let blackhole = tokio::spawn(async move {
            let (connection, _) = listener
                .accept()
                .await
                .expect("accept object-store request");
            let _ = accepted_tx.send(());
            std::future::pending::<()>().await;
            drop(connection);
        });
        let test_budget = S3RequestBudget {
            request_timeout: Duration::from_millis(100),
            connect_timeout: Duration::from_millis(50),
            retry_timeout: Duration::from_millis(100),
            max_retries: 0,
        };
        let object_store = AmazonS3Builder::new()
            .with_endpoint(endpoint)
            .with_bucket_name("test-bucket")
            .with_access_key_id("test-access-key")
            .with_secret_access_key("test-secret-key")
            .with_region("auto")
            .with_client_options(s3_client_options(test_budget))
            .with_retry(s3_retry_config(test_budget))
            .with_allow_http(true)
            .build()
            .expect("build blackhole object store");

        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            object_store.head(&ObjectPath::from("blackholed-head")),
        )
        .await;
        let acceptance = tokio::time::timeout(Duration::from_secs(1), accepted_rx).await;
        blackhole.abort();
        let _ = blackhole.await;
        assert!(
            matches!(acceptance, Ok(Ok(()))),
            "the object-store request never reached the blackhole"
        );

        assert!(
            matches!(result, Ok(Err(_))),
            "unexpected result: {result:?}"
        );
        let elapsed = started.elapsed();
        eprintln!("blackholed S3 HEAD returned after {elapsed:?}");
        assert!(
            elapsed < Duration::from_millis(750),
            "blackholed request exceeded the configured budget: {:?}",
            elapsed
        );
    }
}
