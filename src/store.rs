use crate::{Config, StorageConfig};
use anyhow::{Context, Result};
use slatedb::{
    object_store::{aws::AmazonS3Builder, memory::InMemory, ObjectStore},
    Db,
};
use std::sync::Arc;

pub async fn open_db(config: &Config) -> Result<Arc<Db>> {
    let object_store: Arc<dyn ObjectStore> = match &config.storage {
        StorageConfig::Memory => Arc::new(InMemory::new()),
        StorageConfig::R2 {
            endpoint,
            bucket,
            access_key_id,
            secret_access_key,
            region,
        } => Arc::new(
            AmazonS3Builder::new()
                .with_endpoint(endpoint)
                .with_bucket_name(bucket)
                .with_access_key_id(access_key_id)
                .with_secret_access_key(secret_access_key)
                .with_region(region)
                .with_virtual_hosted_style_request(false)
                .build()
                .context("build R2 object store")?,
        ),
    };

    Db::open(config.slatedb_path.clone(), object_store)
        .await
        .map(Arc::new)
        .context("open SlateDB")
}
