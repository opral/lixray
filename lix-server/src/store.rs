use crate::Config;
use anyhow::{Context, Result};
use lix_engine::Engine;
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
#[cfg(test)]
use object_store::memory::InMemory;
use object_store::{aws::AmazonS3Builder, ObjectStore};
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::time::Instant;
use tokio::runtime::Handle;
use tokio::sync::{Mutex, OnceCell};
use tracing::info;

#[derive(Clone)]
pub struct LixService {
    protocol_lix: Arc<lix_sdk::Lix<SlateDB>>,
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
    runtime: Arc<OnceCell<Arc<LixService>>>,
    last_used: u64,
}

#[derive(Debug)]
pub enum WorkspaceRuntimeError {
    InvalidId,
    AtCapacity { max: usize },
    Open(anyhow::Error),
}

impl WorkspaceRuntimeManager {
    pub fn new(config: &Config) -> Result<Arc<Self>> {
        let storage = &config.storage;
        let object_store: Arc<dyn ObjectStore> = Arc::new(
            AmazonS3Builder::new()
                .with_endpoint(&storage.endpoint)
                .with_bucket_name(&storage.bucket)
                .with_access_key_id(&storage.access_key_id)
                .with_secret_access_key(&storage.secret_access_key)
                .with_region(&storage.region)
                .with_allow_http(storage.allow_http)
                .with_virtual_hosted_style_request(false)
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
            Ok(runtime) => Ok(Arc::clone(runtime)),
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
    ) -> Result<Arc<LixService>> {
        let manager = Arc::clone(self);
        let runtime = Handle::current();
        tokio::task::spawn_blocking(move || runtime.block_on(manager.open_workspace(&workspace_id)))
            .await
            .context("join workspace runtime initialization")?
    }

    async fn open_workspace(&self, workspace_id: &str) -> Result<Arc<LixService>> {
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

        open_or_initialize_engine(storage.clone()).await?;
        let protocol_lix = Arc::new(
            lix_sdk::open_lix_with_storage(storage)
                .await
                .context("open Lix workspace session for the canonical server protocol")?,
        );
        info!(
            workspace_id,
            elapsed_ms = elapsed_millis(started),
            "opened workspace runtime"
        );
        Ok(Arc::new(LixService { protocol_lix }))
    }

    #[cfg(test)]
    async fn cached_workspace_count(&self) -> usize {
        self.state.lock().await.entries.len()
    }
}

impl LixService {
    pub fn protocol_lix(&self) -> Arc<lix_sdk::Lix<SlateDB>> {
        Arc::clone(&self.protocol_lix)
    }
}

impl fmt::Display for WorkspaceRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => write!(formatter, "invalid workspace ID"),
            Self::AtCapacity { max } => write!(
                formatter,
                "workspace service is at its capacity of {max} active runtimes"
            ),
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

async fn open_or_initialize_engine(storage: SlateDB) -> Result<Engine<SlateDB>> {
    match Engine::new(storage.clone()).await {
        Ok(engine) => Ok(engine),
        Err(error) if error.code == "LIX_ERROR_NOT_INITIALIZED" => {
            Engine::initialize(storage.clone())
                .await
                .context("initialize Lix engine")?;
            Engine::new(storage)
                .await
                .context("open initialized Lix engine")
        }
        Err(error) => Err(error).context("open Lix engine"),
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
}
