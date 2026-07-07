use anyhow::{bail, Context, Result};
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub slatedb_path: String,
    pub storage: StorageConfig,
}

#[derive(Clone, Debug)]
pub enum StorageConfig {
    Memory,
    R2 {
        endpoint: String,
        bucket: String,
        access_key_id: String,
        secret_access_key: String,
        region: String,
    },
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let storage_kind = env::var("SLATEDB_STORAGE").unwrap_or_else(|_| "r2".to_string());
        let slatedb_path =
            env::var("SLATEDB_PATH").unwrap_or_else(|_| "lixray/default".to_string());
        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

        let storage = match storage_kind.as_str() {
            "" | "r2" => StorageConfig::R2 {
                endpoint: required_env("R2_ENDPOINT")?,
                bucket: required_env("R2_BUCKET")?,
                access_key_id: required_env("R2_ACCESS_KEY_ID")?,
                secret_access_key: required_env("R2_SECRET_ACCESS_KEY")?,
                region: env::var("R2_REGION").unwrap_or_else(|_| "auto".to_string()),
            },
            "memory" => StorageConfig::Memory,
            other => {
                bail!("unsupported SLATEDB_STORAGE value `{other}`; expected `r2` or `memory`")
            }
        };

        Ok(Self {
            bind_addr,
            slatedb_path,
            storage,
        })
    }
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}
