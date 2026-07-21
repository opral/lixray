use crate::Config;
use anyhow::{Context, Result};
use lix_sdk::{
    CommitResult, GetManyResult, GetOptions, Key, KeyRange, PutBatch, ReadOptions, ScanChunk,
    ScanOptions, SpaceId, Storage, StorageError, StorageRead, StorageWrite, WriteOptions,
};
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
#[cfg(test)]
use object_store::memory::InMemory;
use object_store::{aws::AmazonS3Builder, ClientOptions, ObjectStore, RetryConfig};
#[cfg(test)]
use object_store::{path::Path as ObjectPath, ClientConfigKey, ObjectStoreExt};
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;
use tokio::sync::{Mutex, OnceCell};
use tracing::info;

// SlateDB's disk cache fetches object-store data in 4 MiB parts. A 15 second
// request timeout still permits a part to arrive at roughly 270 KiB/s, while a
// single stalled request can no longer occupy a workspace runtime for the
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

pub struct LixService {
    protocol_lix: Arc<lix_sdk::Lix<MonitoredSlateDB>>,
    storage: MonitoredSlateDB,
}

#[derive(Clone)]
pub(crate) struct MonitoredSlateDB {
    inner: SlateDB,
    // SlateDB keeps this state private. Its commit implementation sets its own
    // terminal bit before returning a commit error, so mirroring that boundary
    // lets the service retire the exact writer that observed the failed WAL
    // durability operation.
    terminal_durability_failure: Arc<AtomicBool>,
}

pub(crate) struct MonitoredSlateDBRead {
    inner: lix_slatedb_storage::SlateDBRead,
    terminal_durability_failure: Arc<AtomicBool>,
}

pub(crate) struct MonitoredSlateDBWrite {
    inner: lix_slatedb_storage::SlateDBWrite,
    terminal_durability_failure: Arc<AtomicBool>,
}

struct WorkspaceRuntime {
    state: Mutex<WorkspaceRuntimeState>,
}

enum WorkspaceRuntimeState {
    Active(Arc<LixService>),
    Recovering,
}

pub struct WorkspaceRuntimeManager {
    backend: StorageBackend,
    max_open_workspaces: usize,
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
    runtime: Arc<OnceCell<Arc<WorkspaceRuntime>>>,
    last_used: u64,
}

#[derive(Debug)]
pub enum WorkspaceRuntimeError {
    InvalidId,
    AtCapacity { max: usize },
    Recovering,
    Open(anyhow::Error),
}

impl WorkspaceRuntimeManager {
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
                max_disk_cache_bytes: per_workspace_usize(
                    storage.cache.max_disk_cache_bytes,
                    config.max_open_workspaces,
                ),
                block_cache_bytes: per_workspace_u64(
                    storage.cache.block_cache_bytes,
                    config.max_open_workspaces,
                ),
                metadata_cache_bytes: per_workspace_u64(
                    storage.cache.metadata_cache_bytes,
                    config.max_open_workspaces,
                ),
            },
        };

        Ok(Arc::new(Self {
            backend,
            max_open_workspaces: config.max_open_workspaces,
            state: Mutex::new(ManagerState::default()),
        }))
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory(max_open_workspaces: usize) -> Arc<Self> {
        Arc::new(Self {
            backend: StorageBackend::Memory {
                object_store: Arc::new(InMemory::new()),
            },
            max_open_workspaces,
            state: Mutex::new(ManagerState::default()),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_with_test_object_store(
        max_open_workspaces: usize,
        object_store: Arc<dyn ObjectStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            backend: StorageBackend::Memory { object_store },
            max_open_workspaces,
            state: Mutex::new(ManagerState::default()),
        })
    }

    pub async fn get(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> std::result::Result<Arc<LixService>, WorkspaceRuntimeError> {
        if !valid_workspace_id(workspace_id) {
            return Err(WorkspaceRuntimeError::InvalidId);
        }

        let runtime_cell = {
            let mut state = self.state.lock().await;
            state.clock = state.clock.wrapping_add(1);
            let now = state.clock;
            if let Some(entry) = state.entries.get_mut(workspace_id) {
                entry.last_used = now;
                Arc::clone(&entry.runtime)
            } else {
                while state.entries.len() >= self.max_open_workspaces {
                    let Some(eviction_id) = idle_lru_workspace(&state.entries) else {
                        return Err(WorkspaceRuntimeError::AtCapacity {
                            max: self.max_open_workspaces,
                        });
                    };
                    state.entries.remove(&eviction_id);
                    info!(workspace_id = %eviction_id, "evicted idle workspace runtime");
                }

                let runtime = Arc::new(OnceCell::new());
                state.entries.insert(
                    workspace_id.to_string(),
                    RuntimeEntry {
                        runtime: Arc::clone(&runtime),
                        last_used: now,
                    },
                );
                runtime
            }
        };

        let result = runtime_cell
            .get_or_try_init(|| self.open_workspace_for_handler(workspace_id.to_string()))
            .await;
        match result {
            Ok(runtime) => {
                let runtime = Arc::clone(runtime);
                match runtime.acquire().await {
                    Some(service) if service.has_terminal_durability_failure() => {
                        self.recover(workspace_id, &service).await;
                        Err(WorkspaceRuntimeError::Recovering)
                    }
                    Some(service) => Ok(service),
                    None => Err(WorkspaceRuntimeError::Recovering),
                }
            }
            Err(error) => {
                let mut state = self.state.lock().await;
                if state
                    .entries
                    .get(workspace_id)
                    .is_some_and(|entry| Arc::ptr_eq(&entry.runtime, &runtime_cell))
                {
                    state.entries.remove(workspace_id);
                }
                Err(WorkspaceRuntimeError::Open(error))
            }
        }
    }

    async fn open_workspace_for_handler(
        self: &Arc<Self>,
        workspace_id: String,
    ) -> Result<Arc<WorkspaceRuntime>> {
        let manager = Arc::clone(self);
        let runtime = Handle::current();
        tokio::task::spawn_blocking(move || runtime.block_on(manager.open_workspace(&workspace_id)))
            .await
            .context("join workspace runtime initialization")?
    }

    async fn open_workspace(&self, workspace_id: &str) -> Result<Arc<WorkspaceRuntime>> {
        let started = Instant::now();
        let storage = match &self.backend {
            #[cfg(test)]
            StorageBackend::Memory { object_store } => {
                SlateDB::open_object_store(workspace_id, Arc::clone(object_store))
                    .context("open in-memory Lix SlateDB storage")?
            }
            StorageBackend::S3 {
                object_store,
                prefix,
                cache,
            } => {
                let storage_prefix = if prefix.is_empty() {
                    workspace_id.to_string()
                } else {
                    format!("{prefix}/{workspace_id}")
                };
                let mut workspace_cache = cache.clone();
                workspace_cache.root_folder = workspace_cache.root_folder.join(workspace_id);
                SlateDB::open_object_store_with_options(
                    storage_prefix,
                    Arc::clone(object_store),
                    SlateDBObjectStoreOptions {
                        cache: Some(workspace_cache),
                    },
                )
                .context("open cached S3-backed Lix SlateDB storage")?
            }
        };

        let storage = MonitoredSlateDB::new(storage);
        let protocol_lix = Arc::new(
            lix_sdk::open_lix_with_telemetry(
                lix_sdk::OpenLixOptions::new(storage.clone()),
                Arc::new(lix_sdk::TracingTelemetrySink::new()),
            )
            .await
            .context("open Lix workspace session for the canonical server protocol")?,
        );
        info!(
            workspace_id,
            elapsed_ms = elapsed_millis(started),
            "opened workspace runtime"
        );
        Ok(Arc::new(WorkspaceRuntime::new(LixService {
            protocol_lix,
            storage,
        })))
    }

    /// Drops a workspace entry whose runtime never finished opening, so the
    /// next request starts a fresh open instead of queueing behind a wedged
    /// one. A no-op once the runtime initialized (recovery handles that case).
    pub(crate) async fn abandon_uninitialized(self: &Arc<Self>, workspace_id: &str) {
        let mut state = self.state.lock().await;
        let uninitialized = state
            .entries
            .get(workspace_id)
            .is_some_and(|entry| entry.runtime.get().is_none());
        if uninitialized {
            state.entries.remove(workspace_id);
            info!(
                workspace_id,
                "abandoned workspace runtime that never opened"
            );
        }
    }

    pub(crate) async fn recover(self: &Arc<Self>, workspace_id: &str, service: &Arc<LixService>) {
        let runtime = {
            let state = self.state.lock().await;
            state
                .entries
                .get(workspace_id)
                .and_then(|entry| entry.runtime.get())
                .cloned()
        };
        let Some(runtime) = runtime else {
            return;
        };
        let Some(draining_service) = runtime.begin_recovery(service).await else {
            return;
        };

        info!(workspace_id, "workspace runtime entering recovery");
        let manager = Arc::clone(self);
        let workspace_id = workspace_id.to_string();
        tokio::spawn(async move {
            let started = Instant::now();
            while Arc::strong_count(&draining_service) > 1 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }

            let close_result = close_drained_service(draining_service).await;
            match close_result {
                Ok(()) => info!(
                    workspace_id,
                    elapsed_ms = elapsed_millis(started),
                    "closed recovered workspace runtime"
                ),
                Err(error) => tracing::warn!(
                    workspace_id,
                    elapsed_ms = elapsed_millis(started),
                    error = %error,
                    "released recovered workspace runtime after close error"
                ),
            }
            manager
                .remove_recovered_runtime(&workspace_id, &runtime)
                .await;
        });
    }

    async fn remove_recovered_runtime(
        &self,
        workspace_id: &str,
        expected_runtime: &Arc<WorkspaceRuntime>,
    ) {
        let mut state = self.state.lock().await;
        if state.entries.get(workspace_id).is_some_and(|entry| {
            entry
                .runtime
                .get()
                .is_some_and(|runtime| Arc::ptr_eq(runtime, expected_runtime))
        }) {
            state.entries.remove(workspace_id);
            info!(workspace_id, "removed recovered workspace runtime");
        }
    }

    #[cfg(test)]
    async fn cached_workspace_count(&self) -> usize {
        self.state.lock().await.entries.len()
    }
}

impl LixService {
    pub(crate) fn protocol_lix(&self) -> Arc<lix_sdk::Lix<MonitoredSlateDB>> {
        Arc::clone(&self.protocol_lix)
    }

    pub(crate) fn has_terminal_durability_failure(&self) -> bool {
        self.storage.has_terminal_durability_failure()
    }

    async fn close(&self) -> Result<()> {
        self.protocol_lix
            .close()
            .await
            .context("close Lix workspace session")
    }
}

impl MonitoredSlateDB {
    fn new(inner: SlateDB) -> Self {
        Self {
            inner,
            terminal_durability_failure: Arc::new(AtomicBool::new(false)),
        }
    }

    fn has_terminal_durability_failure(&self) -> bool {
        self.terminal_durability_failure.load(Ordering::Acquire)
    }

    fn observe_storage_error(&self, error: &StorageError) {
        mark_terminal_on_durability_error(&self.terminal_durability_failure, error);
    }
}

#[allow(
    clippy::manual_async_fn,
    reason = "the Storage traits use explicit Send futures, which keeps the wrapper signatures aligned with SlateDB"
)]
impl Storage for MonitoredSlateDB {
    type Read<'a>
        = MonitoredSlateDBRead
    where
        Self: 'a;
    type Write<'a>
        = MonitoredSlateDBWrite
    where
        Self: 'a;

    fn begin_read(
        &self,
        options: ReadOptions,
    ) -> impl Future<Output = std::result::Result<Self::Read<'_>, StorageError>> + Send {
        async move {
            match self.inner.begin_read(options).await {
                Ok(inner) => Ok(MonitoredSlateDBRead {
                    inner,
                    terminal_durability_failure: Arc::clone(&self.terminal_durability_failure),
                }),
                Err(error) => {
                    self.observe_storage_error(&error);
                    Err(error)
                }
            }
        }
    }

    fn begin_write(
        &self,
        options: WriteOptions,
    ) -> impl Future<Output = std::result::Result<Self::Write<'_>, StorageError>> + Send {
        async move {
            match self.inner.begin_write(options).await {
                Ok(inner) => Ok(MonitoredSlateDBWrite {
                    inner,
                    terminal_durability_failure: Arc::clone(&self.terminal_durability_failure),
                }),
                Err(error) => {
                    self.observe_storage_error(&error);
                    Err(error)
                }
            }
        }
    }
}

#[allow(
    clippy::manual_async_fn,
    reason = "the Storage traits use explicit Send futures, which keeps the wrapper signatures aligned with SlateDB"
)]
impl StorageRead for MonitoredSlateDBRead {
    fn get_many(
        &self,
        space: SpaceId,
        keys: &[Key],
        options: GetOptions,
    ) -> impl Future<Output = std::result::Result<GetManyResult, StorageError>> + Send {
        async move {
            let result = self.inner.get_many(space, keys, options).await;
            observe_durability_result(&self.terminal_durability_failure, &result);
            result
        }
    }

    fn scan(
        &self,
        space: SpaceId,
        range: KeyRange,
        options: ScanOptions,
    ) -> impl Future<Output = std::result::Result<ScanChunk, StorageError>> + Send {
        async move {
            let result = self.inner.scan(space, range, options).await;
            observe_durability_result(&self.terminal_durability_failure, &result);
            result
        }
    }
}

#[allow(
    clippy::manual_async_fn,
    reason = "the Storage traits use explicit Send futures, which keeps the wrapper signatures aligned with SlateDB"
)]
impl StorageWrite for MonitoredSlateDBWrite {
    fn put_many(
        &mut self,
        space: SpaceId,
        entries: PutBatch,
    ) -> impl Future<Output = std::result::Result<(), StorageError>> + Send {
        let terminal_durability_failure = Arc::clone(&self.terminal_durability_failure);
        async move {
            let result = self.inner.put_many(space, entries).await;
            observe_durability_result(&terminal_durability_failure, &result);
            result
        }
    }

    fn delete_many(
        &mut self,
        space: SpaceId,
        keys: &[Key],
    ) -> impl Future<Output = std::result::Result<(), StorageError>> + Send {
        let terminal_durability_failure = Arc::clone(&self.terminal_durability_failure);
        async move {
            let result = self.inner.delete_many(space, keys).await;
            observe_durability_result(&terminal_durability_failure, &result);
            result
        }
    }

    fn delete_range(
        &mut self,
        space: SpaceId,
        range: KeyRange,
    ) -> impl Future<Output = std::result::Result<(), StorageError>> + Send {
        let terminal_durability_failure = Arc::clone(&self.terminal_durability_failure);
        async move {
            let result = self.inner.delete_range(space, range).await;
            observe_durability_result(&terminal_durability_failure, &result);
            result
        }
    }

    fn commit(
        self,
    ) -> impl Future<Output = std::result::Result<CommitResult, StorageError>> + Send {
        async move {
            let Self {
                inner,
                terminal_durability_failure,
            } = self;
            let result = inner.commit().await;
            // SlateDB's commit path marks its internal health terminal before
            // returning any write or flush error.
            if result.is_err() {
                terminal_durability_failure.store(true, Ordering::Release);
            }
            result
        }
    }

    fn rollback(self) -> impl Future<Output = std::result::Result<(), StorageError>> + Send {
        let Self {
            inner,
            terminal_durability_failure,
        } = self;
        async move {
            let result = inner.rollback().await;
            observe_durability_result(&terminal_durability_failure, &result);
            result
        }
    }
}

fn observe_durability_result<T>(
    terminal_durability_failure: &AtomicBool,
    result: &std::result::Result<T, StorageError>,
) {
    if let Err(error) = result {
        mark_terminal_on_durability_error(terminal_durability_failure, error);
    }
}

fn mark_terminal_on_durability_error(
    terminal_durability_failure: &AtomicBool,
    error: &StorageError,
) {
    if matches!(error, StorageError::Durability) {
        terminal_durability_failure.store(true, Ordering::Release);
    }
}

impl WorkspaceRuntime {
    fn new(service: LixService) -> Self {
        Self {
            state: Mutex::new(WorkspaceRuntimeState::Active(Arc::new(service))),
        }
    }

    async fn acquire(&self) -> Option<Arc<LixService>> {
        let state = self.state.lock().await;
        match &*state {
            WorkspaceRuntimeState::Active(service) => Some(Arc::clone(service)),
            WorkspaceRuntimeState::Recovering => None,
        }
    }

    async fn begin_recovery(&self, expected_service: &Arc<LixService>) -> Option<Arc<LixService>> {
        let mut state = self.state.lock().await;
        match &*state {
            WorkspaceRuntimeState::Active(service) if Arc::ptr_eq(service, expected_service) => {
                let WorkspaceRuntimeState::Active(service) =
                    std::mem::replace(&mut *state, WorkspaceRuntimeState::Recovering)
                else {
                    unreachable!("matched active runtime state")
                };
                Some(service)
            }
            WorkspaceRuntimeState::Active(_) | WorkspaceRuntimeState::Recovering => None,
        }
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
    .context("join recovered workspace runtime close")?
}

impl fmt::Display for WorkspaceRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => write!(formatter, "invalid workspace ID"),
            Self::AtCapacity { max } => write!(
                formatter,
                "workspace service is at its capacity of {max} active runtimes"
            ),
            Self::Recovering => write!(formatter, "workspace runtime is recovering"),
            Self::Open(error) => write!(formatter, "open workspace runtime: {error:#}"),
        }
    }
}

impl Error for WorkspaceRuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Open(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

fn valid_workspace_id(workspace_id: &str) -> bool {
    !workspace_id.is_empty()
        && workspace_id.len() <= 128
        && workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn idle_lru_workspace(entries: &HashMap<String, RuntimeEntry>) -> Option<String> {
    entries
        .iter()
        .filter(|(_, entry)| {
            Arc::strong_count(&entry.runtime) == 1
                && entry
                    .runtime
                    .get()
                    .is_some_and(|runtime| Arc::strong_count(runtime) == 1)
        })
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(workspace_id, _)| workspace_id.clone())
}

fn per_workspace_usize(total: usize, workspaces: usize) -> usize {
    total.checked_div(workspaces).unwrap_or(0).max(1)
}

fn per_workspace_u64(total: u64, workspaces: usize) -> u64 {
    total
        .checked_div(u64::try_from(workspaces).unwrap_or(u64::MAX))
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

    fn memory_manager(max_open_workspaces: usize) -> Arc<WorkspaceRuntimeManager> {
        WorkspaceRuntimeManager::new_in_memory(max_open_workspaces)
    }

    #[tokio::test]
    async fn concurrent_gets_share_one_runtime() {
        let manager = memory_manager(2);
        let (left, right) = tokio::join!(manager.get("workspace-a"), manager.get("workspace-a"));
        let left = left.expect("open left runtime");
        let right = right.expect("open right runtime");

        assert!(Arc::ptr_eq(&left, &right));
    }

    #[tokio::test]
    async fn evicts_the_least_recently_used_idle_runtime() {
        let manager = memory_manager(1);
        let first = manager
            .get("workspace-a")
            .await
            .expect("open first runtime");
        drop(first);
        let second = manager
            .get("workspace-b")
            .await
            .expect("open second runtime");

        assert_eq!(manager.cached_workspace_count().await, 1);
        drop(second);
        let reopened = manager
            .get("workspace-a")
            .await
            .expect("reopen first runtime");
        assert_eq!(manager.cached_workspace_count().await, 1);
        drop(reopened);
    }

    #[tokio::test]
    async fn rejects_unsafe_workspace_ids() {
        let manager = memory_manager(1);
        for workspace_id in ["", "../escape", "contains/slash", "contains space"] {
            assert!(matches!(
                manager.get(workspace_id).await,
                Err(WorkspaceRuntimeError::InvalidId)
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
