use anyhow::{bail, Context, Result};
use std::env;
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_CACHE_DIR: &str = "/tmp/lixray-slatedb-cache";
const DEFAULT_DISK_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_BLOCK_CACHE_BYTES: u64 = 128 * 1024 * 1024;
const DEFAULT_METADATA_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_MAX_OPEN_LIXS: u64 = 32;
const DEFAULT_PROTOCOL_TIMEOUT_SECS: u64 = 60;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub internal_token: Option<String>,
    pub max_open_lixes: usize,
    pub protocol_timeout: Duration,
    pub(crate) storage: S3StorageConfig,
}

#[derive(Clone, Debug)]
pub(crate) struct S3StorageConfig {
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) access_key_id: String,
    pub(crate) secret_access_key: String,
    pub(crate) region: String,
    pub(crate) prefix: String,
    pub(crate) allow_http: bool,
    pub(crate) cache: SlateDBCacheConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SlateDBCacheConfig {
    pub(crate) root_folder: PathBuf,
    pub(crate) max_disk_cache_bytes: usize,
    pub(crate) block_cache_bytes: u64,
    pub(crate) metadata_cache_bytes: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| {
            let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
            format!("0.0.0.0:{port}")
        });
        let internal_token = optional_nonempty_env("LIXRAY_INTERNAL_TOKEN")?;
        if env::var_os("RAILWAY_PROJECT_ID").is_some() && internal_token.is_none() {
            bail!("LIXRAY_INTERNAL_TOKEN is required on Railway");
        }
        let max_open_lixes = usize::try_from(positive_u64_env(
            "LIXRAY_MAX_OPEN_LIXS",
            DEFAULT_MAX_OPEN_LIXS,
        )?)
        .context("LIXRAY_MAX_OPEN_LIXS does not fit this platform")?;
        let protocol_timeout = Duration::from_secs(positive_u64_env(
            "LIXRAY_PROTOCOL_TIMEOUT_SECS",
            DEFAULT_PROTOCOL_TIMEOUT_SECS,
        )?);

        let storage = S3StorageConfig {
            endpoint: required_env("S3_ENDPOINT")?,
            bucket: required_env("S3_BUCKET")?,
            access_key_id: required_env("S3_ACCESS_KEY_ID")?,
            secret_access_key: required_env("S3_SECRET_ACCESS_KEY")?,
            region: env::var("S3_REGION").unwrap_or_else(|_| "auto".to_string()),
            prefix: storage_prefix()?,
            allow_http: boolean_env("S3_ALLOW_HTTP", false)?,
            cache: SlateDBCacheConfig::from_env()?,
        };

        Ok(Self {
            bind_addr,
            internal_token,
            max_open_lixes,
            protocol_timeout,
            storage,
        })
    }
}

fn storage_prefix() -> Result<String> {
    let value = match optional_nonempty_env("S3_PREFIX")? {
        Some(value) => value,
        None => match optional_nonempty_env("RAILWAY_ENVIRONMENT_ID")? {
            Some(environment_id) => format!("railway/{environment_id}"),
            None => String::new(),
        },
    };
    let normalized = value.trim_matches('/');
    if normalized.is_empty() {
        return Ok(String::new());
    }
    if normalized.split('/').any(|segment| {
        segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) {
        bail!(
            "S3_PREFIX must contain slash-separated alphanumeric, hyphen, or underscore segments"
        );
    }
    Ok(normalized.to_string())
}

fn boolean_env(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) if value == "true" => Ok(true),
        Ok(value) if value == "false" => Ok(false),
        Ok(_) => bail!("{name} must be `true` or `false`"),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("read {name}")),
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

fn optional_nonempty_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) if value.is_empty() => bail!("{name} must not be empty when set"),
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {name}")),
    }
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
    fn from_env_configures_s3_without_a_lix_path() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();

        let config = Config::from_env().unwrap();

        assert_eq!(config.max_open_lixes, 32);
        assert_eq!(config.bind_addr, "0.0.0.0:8080");
        assert_eq!(config.internal_token, None);
        assert_eq!(config.storage.endpoint, "https://s3.example");
        assert_eq!(config.storage.bucket, "lixray");
        assert_eq!(config.storage.region, "auto");
        assert_eq!(config.storage.prefix, "");
        assert!(!config.storage.allow_http);
        clear_lixray_env();
    }

    #[test]
    fn from_env_uses_platform_port_and_internal_token() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();
        env::set_var("PORT", "4567");
        env::set_var("LIXRAY_INTERNAL_TOKEN", "test-token");

        let config = Config::from_env().unwrap();

        assert_eq!(config.bind_addr, "0.0.0.0:4567");
        assert_eq!(config.internal_token.as_deref(), Some("test-token"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_rejects_empty_internal_token() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("LIXRAY_INTERNAL_TOKEN", "");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("LIXRAY_INTERNAL_TOKEN must not be empty"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_requires_internal_token_on_railway() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("RAILWAY_PROJECT_ID", "project-id");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("LIXRAY_INTERNAL_TOKEN is required on Railway"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_configures_lix_capacity() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();
        env::set_var("LIXRAY_MAX_OPEN_LIXS", "7");

        let config = Config::from_env().unwrap();

        assert_eq!(config.max_open_lixes, 7);
        clear_lixray_env();
    }

    #[test]
    fn from_env_rejects_zero_lix_capacity() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        env::set_var("LIXRAY_MAX_OPEN_LIXS", "0");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("LIXRAY_MAX_OPEN_LIXS must be greater than zero"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_configures_bounded_s3_cache_and_prefix() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();
        env::set_var("S3_PREFIX", "/preview/pr_123/");
        env::set_var("S3_ALLOW_HTTP", "true");
        env::set_var("SLATEDB_CACHE_DIR", "/tmp/test-cache");
        env::set_var("SLATEDB_CACHE_MAX_BYTES", "1024");
        env::set_var("SLATEDB_BLOCK_CACHE_BYTES", "256");
        env::set_var("SLATEDB_METADATA_CACHE_BYTES", "64");

        let config = Config::from_env().unwrap();

        assert_eq!(config.storage.prefix, "preview/pr_123");
        assert!(config.storage.allow_http);
        assert_eq!(
            config.storage.cache,
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
        set_s3_env();
        env::set_var("SLATEDB_CACHE_MAX_BYTES", "0");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("SLATEDB_CACHE_MAX_BYTES must be greater than zero"));
        clear_lixray_env();
    }

    #[test]
    fn from_env_uses_railway_environment_as_default_prefix() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();
        env::set_var("RAILWAY_ENVIRONMENT_ID", "preview-123");

        let config = Config::from_env().unwrap();

        assert_eq!(config.storage.prefix, "railway/preview-123");
        clear_lixray_env();
    }

    #[test]
    fn from_env_rejects_unsafe_s3_prefix() {
        let _guard = env_lock().lock().unwrap();
        clear_lixray_env();
        set_s3_env();
        env::set_var("S3_PREFIX", "preview/../production");

        let error = Config::from_env().unwrap_err();

        assert!(format!("{error:#}").contains("S3_PREFIX"));
        clear_lixray_env();
    }

    fn set_s3_env() {
        env::set_var("S3_ENDPOINT", "https://s3.example");
        env::set_var("S3_BUCKET", "lixray");
        env::set_var("S3_ACCESS_KEY_ID", "access-key");
        env::set_var("S3_SECRET_ACCESS_KEY", "secret-key");
    }

    fn clear_lixray_env() {
        for name in [
            "BIND_ADDR",
            "PORT",
            "LIXRAY_INTERNAL_TOKEN",
            "RAILWAY_PROJECT_ID",
            "RAILWAY_ENVIRONMENT_ID",
            "LIXRAY_MAX_OPEN_LIXS",
            "S3_ENDPOINT",
            "S3_BUCKET",
            "S3_ACCESS_KEY_ID",
            "S3_SECRET_ACCESS_KEY",
            "S3_REGION",
            "S3_PREFIX",
            "S3_ALLOW_HTTP",
            "SLATEDB_CACHE_DIR",
            "SLATEDB_CACHE_MAX_BYTES",
            "SLATEDB_BLOCK_CACHE_BYTES",
            "SLATEDB_METADATA_CACHE_BYTES",
        ] {
            env::remove_var(name);
        }
    }
}
