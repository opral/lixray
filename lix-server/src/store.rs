use crate::{Config, StorageConfig};
use anyhow::{Context, Result};
use lix_engine::Engine;
use lix_slatedb_storage::{SlateDB, SlateDBCacheOptions, SlateDBObjectStoreOptions};
use object_store::{aws::AmazonS3Builder, memory::InMemory, ObjectStore};
use std::sync::Arc;
use std::time::Instant;
use tracing::info;

#[derive(Clone)]
pub struct LixService {
    protocol_lix: Arc<lix_sdk::Lix<SlateDB>>,
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
    open_or_initialize_engine(storage.clone()).await?;
    let protocol_lix = Arc::new(
        lix_sdk::open_lix_with_storage(storage)
            .await
            .context("open Lix workspace session for the canonical server protocol")?,
    );

    Ok(Arc::new(LixService { protocol_lix }))
}

impl LixService {
    pub fn protocol_lix(&self) -> Arc<lix_sdk::Lix<SlateDB>> {
        Arc::clone(&self.protocol_lix)
    }
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
