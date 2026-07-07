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
        let slatedb_path = required_env("SLATEDB_PATH")?;
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
        ] {
            env::remove_var(name);
        }
    }
}
