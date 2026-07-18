use crate::{Config, StorageConfig};
use anyhow::{Context, Result};
use lix_engine::{
    parse_sql_script, CreateBranchOptions, CreateBranchReceipt, Engine, ExecuteOptions,
    ExecuteResult, LixError, ObserveEvent, ObserveEvents, Value,
};
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
use object_store::{aws::AmazonS3Builder, memory::InMemory, ObjectStore};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::runtime::Handle;
use tracing::{info, warn};

#[derive(Clone)]
pub struct LixService {
    engine: Engine<SlateDB>,
}

#[derive(Debug, Clone, Copy)]
pub enum FilesystemEntryKind {
    File,
    Directory,
}

#[derive(Debug)]
pub enum FilesystemMutation {
    ReplaceFile { data: Value, metadata: Value },
    Move { destination_path: String },
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilesystemMutationOutcome {
    Applied,
    Conflict,
    AlreadyExists,
}

pub async fn open_lix_service(config: &Config) -> Result<Arc<LixService>> {
    let storage = match &config.storage {
        StorageConfig::Memory => {
            SlateDB::open_object_store(config.slatedb_path.clone(), Arc::new(InMemory::new()))
                .context("open in-memory Lix SlateDB storage")?
        }
        StorageConfig::R2 {
            endpoint,
            bucket,
            access_key_id,
            secret_access_key,
            region,
            cache,
        } => {
            let object_store: Arc<dyn ObjectStore> = Arc::new(
                AmazonS3Builder::new()
                    .with_endpoint(endpoint)
                    .with_bucket_name(bucket)
                    .with_access_key_id(access_key_id)
                    .with_secret_access_key(secret_access_key)
                    .with_region(region)
                    .with_virtual_hosted_style_request(false)
                    .build()
                    .context("build R2 object store")?,
            );
            let started = Instant::now();
            info!(
                max_disk_cache_bytes = cache.max_disk_cache_bytes,
                block_cache_bytes = cache.block_cache_bytes,
                metadata_cache_bytes = cache.metadata_cache_bytes,
                "opening R2-backed SlateDB with bounded local cache"
            );
            let storage = SlateDB::open_object_store_with_options(
                config.slatedb_path.clone(),
                object_store,
                SlateDBObjectStoreOptions {
                    cache: Some(SlateDBCacheOptions {
                        root_folder: cache.root_folder.clone(),
                        max_disk_cache_bytes: cache.max_disk_cache_bytes,
                        block_cache_bytes: cache.block_cache_bytes,
                        metadata_cache_bytes: cache.metadata_cache_bytes,
                    }),
                },
            )
            .context("open cached Lix SlateDB storage")?;
            info!(
                elapsed_ms = elapsed_millis(started),
                "opened and preloaded R2-backed SlateDB"
            );
            storage
        }
    };
    let engine = open_or_initialize_engine(storage).await?;

    Ok(Arc::new(LixService { engine }))
}

impl LixService {
    pub async fn current_branch_id(&self) -> Result<String, LixError> {
        self.run("current_branch_id", |engine| async move {
            let session = engine.open_workspace_session().await?;
            session.active_branch_id().await
        })
        .await
    }

    pub async fn list_branches(&self) -> Result<ExecuteResult, LixError> {
        self.run("list_branches", |engine| async move {
            let session = engine.open_workspace_session().await?;
            session
                .execute(
                    "SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id",
                    &[],
                )
                .await
        })
        .await
    }

    pub async fn create_branch(
        &self,
        branch_id: String,
        options: CreateBranchOptions,
    ) -> Result<CreateBranchReceipt, LixError> {
        self.run("create_branch", move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, "createBranch").await?;
            let session = engine.open_session(branch_id).await?;
            session.create_branch(options).await
        })
        .await
    }

    pub async fn switch_branch(&self, branch_id: String) -> Result<String, LixError> {
        // Remote clients keep their active branch locally and include it on
        // every operation. The server-side switch therefore validates the
        // branch before acknowledging the client's local state change.
        self.validate_branch(branch_id.clone(), "switchBranch")
            .await?;
        Ok(branch_id)
    }

    pub async fn validate_branch(
        &self,
        branch_id: String,
        operation: &'static str,
    ) -> Result<(), LixError> {
        self.run(operation, move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, operation).await
        })
        .await
    }

    pub async fn execute_script(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
        options: ExecuteOptions,
    ) -> Result<Vec<ExecuteResult>, LixError> {
        self.run("execute", move |engine| async move {
            // A pinned session does not validate its branch until a branch-aware
            // operation runs. Keep this guard so branch-free SQL cannot succeed
            // against a missing branch.
            ensure_branch_exists(&engine, &branch_id, "execute").await?;
            let plan = parse_sql_script(&sql, params.len())?;
            let session = engine.open_session(branch_id).await?;

            if let [statement] = plan.statements.as_slice() {
                let result = session
                    .execute_with_options(
                        &statement.sql,
                        &params[statement.params.clone()],
                        options,
                    )
                    .await?;
                return Ok(vec![result]);
            }

            let mut transaction = session.begin_transaction().await?;
            let mut results = Vec::with_capacity(plan.statements.len());
            for statement in plan.statements {
                match transaction
                    .execute_with_options(
                        &statement.sql,
                        &params[statement.params],
                        options.clone(),
                    )
                    .await
                {
                    Ok(result) => results.push(result),
                    Err(error) => {
                        if let Err(rollback_error) = transaction.rollback().await {
                            warn!(
                                error = ?rollback_error,
                                "failed to roll back SQL transaction after statement error"
                            );
                        }
                        return Err(error);
                    }
                }
            }
            transaction.commit().await?;
            Ok(results)
        })
        .await
    }

    pub async fn mutate_filesystem(
        &self,
        branch_id: String,
        kind: FilesystemEntryKind,
        path: String,
        expected_revision: String,
        mutation: FilesystemMutation,
    ) -> Result<FilesystemMutationOutcome, LixError> {
        self.run("mutate_filesystem", move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, "mutateFilesystem").await?;
            let session = engine.open_session(branch_id).await?;
            let mut transaction = session.begin_transaction().await?;
            let table = match kind {
                FilesystemEntryKind::File => "lix_file",
                FilesystemEntryKind::Directory => "lix_directory",
            };
            let current = transaction
                .execute(
                    &format!("SELECT id, lixcol_change_id FROM {table} WHERE path = $1"),
                    &[Value::Text(path)],
                )
                .await?;
            let Some(row) = current.rows().first() else {
                transaction.rollback().await?;
                return Ok(FilesystemMutationOutcome::Conflict);
            };
            let id = required_row_text(row, "id")?;
            let revision = required_row_text(row, "lixcol_change_id")?;
            if revision != expected_revision {
                transaction.rollback().await?;
                return Ok(FilesystemMutationOutcome::Conflict);
            }

            let result = match mutation {
                FilesystemMutation::ReplaceFile { data, metadata } => {
                    if !matches!(kind, FilesystemEntryKind::File) {
                        transaction.rollback().await?;
                        return Err(LixError::new(
                            LixError::CODE_INVALID_PARAM,
                            "replace_file requires a file entry",
                        ));
                    }
                    transaction
                        .execute(
                            "UPDATE lix_file SET data = $1, lixcol_metadata = $2 WHERE id = $3",
                            &[data, metadata, Value::Text(id)],
                        )
                        .await?
                }
                FilesystemMutation::Move { destination_path } => {
                    let file_path = destination_path.trim_end_matches('/').to_string();
                    let directory_path = format!("{file_path}/");
                    let file_collision = transaction
                        .execute(
                            "SELECT id FROM lix_file WHERE path = $1",
                            &[Value::Text(file_path)],
                        )
                        .await?;
                    let directory_collision = transaction
                        .execute(
                            "SELECT id FROM lix_directory WHERE path = $1",
                            &[Value::Text(directory_path)],
                        )
                        .await?;
                    if !file_collision.is_empty() || !directory_collision.is_empty() {
                        transaction.rollback().await?;
                        return Ok(FilesystemMutationOutcome::AlreadyExists);
                    }
                    transaction
                        .execute(
                            &format!("UPDATE {table} SET path = $1 WHERE id = $2"),
                            &[Value::Text(destination_path), Value::Text(id)],
                        )
                        .await?
                }
                FilesystemMutation::Delete => {
                    transaction
                        .execute(
                            &format!("DELETE FROM {table} WHERE id = $1"),
                            &[Value::Text(id)],
                        )
                        .await?
                }
            };

            if result.rows_affected() != 1 {
                transaction.rollback().await?;
                return Ok(FilesystemMutationOutcome::Conflict);
            }
            transaction.commit().await?;
            Ok(FilesystemMutationOutcome::Applied)
        })
        .await
    }

    pub async fn observe(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
    ) -> Result<LixObserve, LixError> {
        self.open_observe(branch_id, sql, params, true).await
    }

    pub async fn observe_validated(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
    ) -> Result<LixObserve, LixError> {
        self.open_observe(branch_id, sql, params, false).await
    }

    async fn open_observe(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
        validate_branch: bool,
    ) -> Result<LixObserve, LixError> {
        self.run("observe", move |engine| async move {
            if validate_branch {
                ensure_branch_exists(&engine, &branch_id, "observe").await?;
            }
            let session = engine.open_session(branch_id).await?;
            let events = session.observe(&sql, &params)?;
            Ok(LixObserve {
                events: Arc::new(Mutex::new(events)),
            })
        })
        .await
    }

    async fn run<T, F, Fut>(
        &self,
        operation_name: &'static str,
        operation: F,
    ) -> Result<T, LixError>
    where
        T: Send + 'static,
        F: FnOnce(Engine<SlateDB>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, LixError>> + 'static,
    {
        let started = Instant::now();
        let engine = self.engine.clone();
        let runtime = Handle::try_current().map_err(|error| {
            LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("access Lix runtime: {error}"),
            )
        })?;
        let result = tokio::task::spawn_blocking(move || runtime.block_on(operation(engine)))
            .await
            .map_err(|error| {
                LixError::new(
                    LixError::CODE_INTERNAL_ERROR,
                    format!("join Lix runtime task: {error}"),
                )
            });
        match &result {
            Ok(Ok(_)) => info!(
                operation = operation_name,
                elapsed_ms = elapsed_millis(started),
                "completed Lix operation"
            ),
            Ok(Err(error)) => warn!(
                operation = operation_name,
                elapsed_ms = elapsed_millis(started),
                error_code = %error.code,
                "Lix operation failed"
            ),
            Err(error) => warn!(
                operation = operation_name,
                elapsed_ms = elapsed_millis(started),
                error = %error,
                "Lix blocking task failed"
            ),
        }
        result?
    }
}

fn required_row_text(row: &lix_engine::Row, column: &str) -> Result<String, LixError> {
    match row.value(column)? {
        Value::Text(value) => Ok(value.clone()),
        value => Err(LixError::new(
            LixError::CODE_TYPE_MISMATCH,
            format!("expected text column {column}, got {value:?}"),
        )),
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

async fn ensure_branch_exists(
    engine: &Engine<SlateDB>,
    branch_id: &str,
    operation: &str,
) -> Result<(), LixError> {
    if engine
        .load_branch_head_commit_id(branch_id)
        .await?
        .is_some()
    {
        return Ok(());
    }

    Err(LixError::branch_not_found(
        branch_id.to_string(),
        operation,
        "branchId",
    ))
}

pub struct LixObserve {
    events: Arc<Mutex<ObserveEvents<SlateDB>>>,
}

impl LixObserve {
    pub async fn next(&mut self) -> Result<Option<ObserveEvent>, LixError> {
        let runtime = Handle::try_current().map_err(|error| {
            LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("access Lix observe runtime: {error}"),
            )
        })?;
        let events = Arc::clone(&self.events);
        // A started spawn_blocking task cannot be aborted. Keep this sender in
        // the pending next() future so dropping that future wakes the blocking
        // task and releases its observe stream without waiting for a mutation.
        let (cancel_on_drop, cancel) = tokio::sync::oneshot::channel::<()>();
        let result = tokio::task::spawn_blocking(move || {
            let mut events = events.lock().map_err(|error| {
                LixError::new(
                    LixError::CODE_INTERNAL_ERROR,
                    format!("lock Lix observe stream: {error}"),
                )
            })?;
            runtime.block_on(async {
                tokio::select! {
                    result = events.next() => result,
                    _ = cancel => Err(LixError::new(
                        LixError::CODE_CLOSED,
                        "Lix observe wait was cancelled",
                    )),
                }
            })
        })
        .await
        .map_err(|error| {
            LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("join Lix observe task: {error}"),
            )
        })?;
        // Keep the cancellation sender alive until the blocking task has
        // returned on the normal path.
        drop(cancel_on_drop);
        result
    }
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    #[tokio::test]
    async fn dropping_pending_observe_next_stops_its_blocking_task() {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let service = open_lix_service(&Config {
            bind_addr: "127.0.0.1:0".to_string(),
            slatedb_path: format!("store-observe-cancel-{}-{id}", std::process::id()),
            storage: StorageConfig::Memory,
        })
        .await
        .expect("open cancellation-test Lix service");
        let branches = service
            .list_branches()
            .await
            .expect("list cancellation-test branches");
        let main_branch_id = branches
            .rows()
            .iter()
            .find(|row| matches!(row.value("name"), Ok(Value::Text(name)) if name == "main"))
            .and_then(|row| match row.value("id").ok()? {
                Value::Text(id) => Some(id.clone()),
                _ => None,
            })
            .expect("find cancellation-test main branch");
        let mut observe = service
            .observe(main_branch_id, "SELECT 1 AS value".to_string(), Vec::new())
            .await
            .expect("open cancellation-test observe stream");
        assert!(observe
            .next()
            .await
            .expect("read initial observe event")
            .is_some());

        // The test and LixObserve each hold one Arc. A third reference proves
        // the blocking task has been dispatched and owns the stream wait.
        let events = Arc::clone(&observe.events);
        let mut pending = Box::pin(observe.next());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                tokio::select! {
                    result = &mut pending => panic!("observe unexpectedly completed: {result:?}"),
                    _ = tokio::task::yield_now() => {}
                }
                if Arc::strong_count(&events) == 3 {
                    break;
                }
            }
        })
        .await
        .expect("blocking observe task should start");

        drop(pending);

        tokio::time::timeout(Duration::from_secs(2), async {
            while Arc::strong_count(&events) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled blocking observe task should release its stream");
    }
}
