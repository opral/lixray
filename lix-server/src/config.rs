use anyhow::{bail, Context, Result};
use std::env;
use std::path::PathBuf;

const DEFAULT_CACHE_DIR: &str = "/tmp/lixray-slatedb-cache";
const DEFAULT_DISK_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_BLOCK_CACHE_BYTES: u64 = 128 * 1024 * 1024;
const DEFAULT_METADATA_CACHE_BYTES: u64 = 32 * 1024 * 1024;

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
        cache: SlateDBCacheConfig,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlateDBCacheConfig {
    pub root_folder: PathBuf,
    pub max_disk_cache_bytes: usize,
    pub block_cache_bytes: u64,
    pub metadata_cache_bytes: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let storage_kind = env::var("SLATEDB_STORAGE").unwrap_or_else(|_| "r2".to_string());
        let slatedb_path = required_env("SLATEDB_PATH")?;
        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

        let storage = match storage_kind.as_str() {
            "" | "r2" => StorageConfig::R2 {
                endpoint: required_env("R2_ENDPOINT")?,
                bucket: required_env("R2_BUCKET")?,
                access_key_id: required_env("R2_ACCESS_KEY_ID")?,
                secret_access_key: required_env("R2_SECRET_ACCESS_KEY")?,
                region: env::var("R2_REGION").unwrap_or_else(|_| "auto".to_string()),
                cache: SlateDBCacheConfig::from_env()?,
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

impl SlateDBCacheConfig {
    fn from_env() -> Result<Self> {
        let root_folder =
            env::var("SLATEDB_CACHE_DIR").unwrap_or_else(|_| DEFAULT_CACHE_DIR.to_string());
        if root_folder.trim().is_empty() {
            bail!("SLATEDB_CACHE_DIR must not be empty");
        }
        let disk_cache_bytes =
            positive_u64_env("SLATEDB_CACHE_MAX_BYTES", DEFAULT_DISK_CACHE_BYTES)?;
        let max_disk_cache_bytes = usize::try_from(disk_cache_bytes)
            .context("SLATEDB_CACHE_MAX_BYTES does not fit this platform")?;

        Ok(Self {
            root_folder: PathBuf::from(root_folder),
            max_disk_cache_bytes,
            block_cache_bytes: positive_u64_env(
                "SLATEDB_BLOCK_CACHE_BYTES",
                DEFAULT_BLOCK_CACHE_BYTES,
            )?,
            metadata_cache_bytes: positive_u64_env(
                "SLATEDB_METADATA_CACHE_BYTES",
                DEFAULT_METADATA_CACHE_BYTES,
            )?,
        })
    }
}

fn positive_u64_env(name: &str, default: u64) -> Result<u64> {
    let value = match env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("{name} must be a positive integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("read {name}")),
    };
    if value == 0 {
        bail!("{name} must be greater than zero");
    }
    Ok(value)
}

fn required_env(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("{name} is required"))?;
    if value.is_empty() {
        bail!("{name} is required");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn from_env_requires_slatedb_path() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("SLATEDB_STORAGE", "memory");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("SLATEDB_PATH is required"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_rejects_empty_slatedb_path() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("SLATEDB_STORAGE", "memory");
        env::set_var("SLATEDB_PATH", "");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("SLATEDB_PATH is required"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_uses_required_slatedb_path() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("SLATEDB_STORAGE", "memory");
        env::set_var("SLATEDB_PATH", "org_123");

        let config = Config::from_env().unwrap();

        assert_eq!(config.slatedb_path, "org_123");
        assert!(matches!(config.storage, StorageConfig::Memory));
        clear_lixray_env();
    }

    #[test]
    fn from_env_configures_bounded_r2_cache() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("SLATEDB_PATH", "org_123");
        env::set_var("R2_ENDPOINT", "https://r2.example");
        env::set_var("R2_BUCKET", "lixray");
        env::set_var("R2_ACCESS_KEY_ID", "access-key");
        env::set_var("R2_SECRET_ACCESS_KEY", "secret-key");
        env::set_var("SLATEDB_CACHE_DIR", "/tmp/test-cache");
        env::set_var("SLATEDB_CACHE_MAX_BYTES", "1024");
        env::set_var("SLATEDB_BLOCK_CACHE_BYTES", "256");
        env::set_var("SLATEDB_METADATA_CACHE_BYTES", "64");

        let config = Config::from_env().unwrap();
        let StorageConfig::R2 { cache, .. } = config.storage else {
            panic!("expected R2 storage");
        };

        assert_eq!(
            cache,
            SlateDBCacheConfig {
                root_folder: PathBuf::from("/tmp/test-cache"),
                max_disk_cache_bytes: 1024,
                block_cache_bytes: 256,
                metadata_cache_bytes: 64,
            }
        );
        clear_lixray_env();
    }

    #[test]
    fn from_env_rejects_zero_cache_sizes() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("SLATEDB_PATH", "org_123");
        env::set_var("R2_ENDPOINT", "https://r2.example");
        env::set_var("R2_BUCKET", "lixray");
        env::set_var("R2_ACCESS_KEY_ID", "access-key");
        env::set_var("R2_SECRET_ACCESS_KEY", "secret-key");
        env::set_var("SLATEDB_CACHE_MAX_BYTES", "0");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("SLATEDB_CACHE_MAX_BYTES must be greater than zero"));
        clear_lixray_env();
    }

    fn clear_lixray_env() {
        for name in [
            "BIND_ADDR",
            "SLATEDB_STORAGE",
            "SLATEDB_PATH",
            "R2_ENDPOINT",
            "R2_BUCKET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_REGION",
            "SLATEDB_CACHE_DIR",
            "SLATEDB_CACHE_MAX_BYTES",
            "SLATEDB_BLOCK_CACHE_BYTES",
            "SLATEDB_METADATA_CACHE_BYTES",
        ] {
            env::remove_var(name);
        }
    }
}
