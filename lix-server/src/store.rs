use crate::{Config, StorageConfig};
use anyhow::{Context, Result};
use lix_engine::{Engine, LixError, Value};
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
use object_store::{aws::AmazonS3Builder, memory::InMemory, ObjectStore};
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;
use tokio::runtime::Handle;
use tracing::{info, warn};

#[derive(Clone)]
pub struct LixService {
    engine: Engine<SlateDB>,
    protocol_lix: Arc<lix_sdk::Lix<SlateDB>>,
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
    let engine = open_or_initialize_engine(storage.clone()).await?;
    let protocol_lix = Arc::new(
        lix_sdk::open_lix_with_storage(storage)
            .await
            .context("open Lix workspace session for the canonical server protocol")?,
    );

    Ok(Arc::new(LixService {
        engine,
        protocol_lix,
    }))
}

impl LixService {
    pub fn protocol_lix(&self) -> Arc<lix_sdk::Lix<SlateDB>> {
        Arc::clone(&self.protocol_lix)
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
