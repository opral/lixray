use crate::{Config, StorageConfig};
use anyhow::{Context, Result};
use lix_backends::SlateDbBackend;
use lix_engine::{
    CreateBranchOptions, CreateBranchReceipt, Engine, ExecuteOptions, ExecuteResult, LixError,
    ObserveEvent, ObserveEvents, Value,
};
use object_store::{aws::AmazonS3Builder, memory::InMemory, ObjectStore};
use std::future::Future;
use std::sync::Arc;
use tokio::runtime::Builder;

#[derive(Clone)]
pub struct LixService {
    engine: Engine<SlateDbBackend>,
}

pub async fn open_lix_service(config: &Config) -> Result<Arc<LixService>> {
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

    let backend = SlateDbBackend::open_object_store(config.slatedb_path.clone(), object_store)
        .context("open Lix SlateDB backend")?;
    let engine = open_or_initialize_engine(backend).await?;

    Ok(Arc::new(LixService { engine }))
}

impl LixService {
    pub async fn list_branches(&self) -> Result<ExecuteResult, LixError> {
        self.run(|engine| async move {
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
        self.run(move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, "createBranch").await?;
            let session = engine.open_session(branch_id).await?;
            session.create_branch(options).await
        })
        .await
    }

    pub async fn execute(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
        options: ExecuteOptions,
    ) -> Result<ExecuteResult, LixError> {
        self.run(move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, "execute").await?;
            let session = engine.open_session(branch_id).await?;
            session.execute_with_options(&sql, &params, options).await
        })
        .await
    }

    pub async fn observe(
        &self,
        branch_id: String,
        sql: String,
        params: Vec<Value>,
    ) -> Result<LixObserve, LixError> {
        self.run(move |engine| async move {
            ensure_branch_exists(&engine, &branch_id, "observe").await?;
            let session = engine.open_session(branch_id).await?;
            let events = session.observe(&sql, &params)?;
            Ok(LixObserve {
                events: Some(events),
            })
        })
        .await
    }

    async fn run<T, F, Fut>(&self, operation: F) -> Result<T, LixError>
    where
        T: Send + 'static,
        F: FnOnce(Engine<SlateDbBackend>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, LixError>> + 'static,
    {
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || {
            let runtime = Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    LixError::new(
                        LixError::CODE_INTERNAL_ERROR,
                        format!("create Lix runtime: {error}"),
                    )
                })?;
            runtime.block_on(operation(engine))
        })
        .await
        .map_err(|error| {
            LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("join Lix runtime task: {error}"),
            )
        })?
    }
}

async fn ensure_branch_exists(
    engine: &Engine<SlateDbBackend>,
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
    events: Option<ObserveEvents<SlateDbBackend>>,
}

impl LixObserve {
    pub async fn next(&mut self) -> Result<Option<ObserveEvent>, LixError> {
        let mut events = self.events.take().ok_or_else(|| {
            LixError::new(
                LixError::CODE_CLOSED,
                "Lix observe stream is already closed",
            )
        })?;

        let (events, result) = tokio::task::spawn_blocking(move || {
            let runtime = Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    LixError::new(
                        LixError::CODE_INTERNAL_ERROR,
                        format!("create Lix observe runtime: {error}"),
                    )
                })?;
            let result = runtime.block_on(events.next());
            Ok::<_, LixError>((events, result))
        })
        .await
        .map_err(|error| {
            LixError::new(
                LixError::CODE_INTERNAL_ERROR,
                format!("join Lix observe task: {error}"),
            )
        })??;

        self.events = Some(events);
        result
    }
}

async fn open_or_initialize_engine(backend: SlateDbBackend) -> Result<Engine<SlateDbBackend>> {
    match Engine::new(backend.clone()).await {
        Ok(engine) => Ok(engine),
        Err(error) if error.code == "LIX_ERROR_NOT_INITIALIZED" => {
            Engine::initialize(backend.clone())
                .await
                .context("initialize Lix engine")?;
            Engine::new(backend)
                .await
                .context("open initialized Lix engine")
        }
        Err(error) => Err(error).context("open Lix engine"),
    }
}
