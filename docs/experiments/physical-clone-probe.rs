//! Ignored offline replay of an exact, bounded production physical clone.
//!
//! This harness opens only a disposable copy of the clone, serves the real
//! protocol handler over loopback, then runs a cold Memory partial replica.
//! It is intentionally opt-in because callers must provide the clone paths.

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{Method, Request, Response, StatusCode};
use axum::routing::any;
use lix_sdk::server_protocol::{LixServerProtocol, ServerProtocolBody, ServerProtocolContext};
use lix_slatedb_storage::{SlateDB, SlateDBObjectStoreOptions};
use object_store::{ObjectStore, local::LocalFileSystem};
use std::path::Path;
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::test]
#[ignore = "manual offline production physical-clone replay"]
async fn cold_global_sql_from_production_physical_clone() {
    let root = std::env::var("LIX_PHYSICAL_CLONE_ROOT")
        .expect("set LIX_PHYSICAL_CLONE_ROOT to the physical clone parent");
    let storage_id = std::env::var("LIX_PHYSICAL_CLONE_STORAGE_ID")
        .expect("set LIX_PHYSICAL_CLONE_STORAGE_ID to the physical storage UUID");
    let repository_id = std::env::var("LIX_PHYSICAL_CLONE_REPOSITORY_ID")
        .expect("set LIX_PHYSICAL_CLONE_REPOSITORY_ID to the public repository UUID");
    assert_eq!(
        uuid::Uuid::parse_str(&storage_id).unwrap().to_string(),
        storage_id
    );
    assert_eq!(
        uuid::Uuid::parse_str(&repository_id).unwrap().to_string(),
        repository_id
    );

    let source = Path::new(&root).join(&storage_id);
    assert!(
        source.is_dir(),
        "physical clone storage directory is absent"
    );
    let disposable = tempfile::tempdir().unwrap();
    let copy = disposable.path().join(&storage_id);
    copy_tree(&source, &copy);

    let object_store: Arc<dyn ObjectStore> =
        Arc::new(LocalFileSystem::new_with_prefix(disposable.path()).unwrap());
    let storage = SlateDB::open_object_store_with_options(
        storage_id,
        object_store,
        SlateDBObjectStoreOptions::default(),
    )
    .unwrap();
    let authority = lix_sdk::open_lix()
        .with_storage(storage)
        .serve()
        .with_lix_id(repository_id.clone())
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/{*path}", any(handle_protocol_request))
        .with_state(authority.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let mut failure_stage = "replica_open";
    let last_open_progress = Arc::new(std::sync::Mutex::new(None));
    let run_result: anyhow::Result<()> = async {
        failure_stage = "replica_storage_open";
        let replica_storage =
            lix_filesystem_storage::FilesystemStorage::new(disposable.path().join("fresh-replica"))
                .open()?;
        failure_stage = "replica_open";
        let observed_progress = Arc::clone(&last_open_progress);
        let replica = lix_sdk::open_lix()
            .with_storage(replica_storage)
            .with_server(lix_sdk::ServerOptions::new(format!(
                "http://{address}/lix/{repository_id}"
            )))
            .on_progress(move |event| {
                *observed_progress
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some((event.scope, event.phase));
            })
            .await?;
        let query_result = run_cold_global_queries(&replica, &mut failure_stage).await;
        if query_result.is_ok() {
            failure_stage = "replica_close";
        }
        let close_result = replica.close().await;
        query_result?;
        close_result?;
        Ok(())
    }
    .await;
    if let Err(error) = &run_result {
        let lix_error = error.downcast_ref::<lix_sdk::LixError>();
        let error_code = lix_error.map_or("non_lix_error", |error| error.code.as_str());
        let error_category = lix_error.map_or("non_lix_error", |error| {
            safe_error_category(&error.code, &error.message)
        });
        let progress = *last_open_progress
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (scope, phase) = progress.map_or(("none", "none"), |(scope, phase)| {
            let scope = match scope {
                lix_sdk::OpenScope::Local => "local",
                lix_sdk::OpenScope::Authority => "authority",
            };
            let phase = match phase {
                lix_sdk::OpenPhase::Inspecting => "inspecting",
                lix_sdk::OpenPhase::Migrating => "migrating",
                lix_sdk::OpenPhase::Validating => "validating",
                lix_sdk::OpenPhase::Opening => "opening",
                lix_sdk::OpenPhase::Complete => "complete",
                _ => "unknown",
            };
            (scope, phase)
        });
        eprintln!(
            "offline_clone_probe failed stage={failure_stage} error_code={error_code} category={error_category} progress_scope={scope} progress_phase={phase} diagnostics={}",
            lix_error
                .map(safe_payload_diagnostics)
                .unwrap_or_else(|| "none".to_owned())
        );
    }

    let close_result = authority.close().await;
    server.abort();
    assert!(
        run_result.is_ok(),
        "cold query against offline clone failed"
    );
    assert!(close_result.is_ok(), "offline clone authority close failed");
}

fn safe_error_category(code: &str, message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if message.contains("canonical change payload has no matching row recipe") {
        "change_payload_not_selected_by_recipe"
    } else if message.contains("canonical change payload is outside the descriptor branch scope") {
        "change_payload_outside_descriptor_scope"
    } else if message.contains("canonical change payload has no selected source locator") {
        "change_payload_missing_source_locator"
    } else if message.contains("canonical change payload source disagrees") {
        "change_payload_source_locator_mismatch"
    } else if message.contains("canonical selected change payload identity or lifetime mismatch") {
        "change_payload_identity_or_lifetime_mismatch"
    } else if message.contains("canonical selected change payload cannot replace a required input")
    {
        "required_change_payload_replacement"
    } else if message.contains("resident change payload changed during canonical repair") {
        "resident_change_payload_changed_during_repair"
    } else if message.contains("resident mutable payload changed during canonical repair") {
        "resident_mutable_payload_changed_during_repair"
    } else if message.contains("read fulfillment conflicts with resident input") {
        "resident_input_conflict"
    } else if message.contains("read fulfillment omitted a required input") {
        "required_input_omitted"
    } else if message.contains("canonical change payload timestamp must be canonical") {
        "change_payload_timestamp_noncanonical"
    } else if message.contains("change payload ID must be a canonical UUID") {
        "change_payload_id_noncanonical"
    } else if message.contains("change payload source must be a canonical UUID") {
        "change_payload_source_noncanonical"
    } else if message.contains("invalid canonical selected change payload") {
        "change_payload_malformed"
    } else if message.contains("resident mutable change payload does not match") {
        "resident_change_payload_identity_mismatch"
    } else if message.contains("selected change payload conflicts with observed input") {
        "selected_payload_conflicts_with_observation"
    } else if message.contains("required read input conflicts with retained owner") {
        "required_input_conflicts_with_retained_owner"
    } else if message.contains("partial admission is missing") {
        "partial_admission_missing"
    } else if message.contains("local owner header has no mutation authority") {
        "local_owner_mutation_authority_missing"
    } else if message.contains("local owner header has no mutation catalog") {
        "local_owner_mutation_catalog_missing"
    } else if message.contains("resident chunk presence is inconsistent") {
        "resident_chunk_presence_inconsistent"
    } else if message.contains("blob input conflicts with resident chunk") {
        "resident_chunk_conflict"
    } else if message.contains("read fulfillment basis changed") {
        "fulfillment_basis_changed"
    } else if message.contains("read fulfillment closure is incomplete or mismatched") {
        "closure_incomplete_or_mismatched"
    } else if message.contains("read fulfillment exceeds bound")
        || message.contains("read assembly exceeds bound")
        || message.contains("payload limit")
    {
        "fulfillment_size_or_count_bound"
    } else if message.contains("permission") || message.contains("denied") {
        "permission"
    } else if message.contains("unsupported capability") {
        "unsupported_capability"
    } else if message.contains("invalid key") {
        "invalid_key"
    } else if message.contains("invalid cursor") {
        "invalid_cursor"
    } else if message.contains("already open") || message.contains("in use") {
        "storage_in_use"
    } else if message.contains("io error") {
        "io"
    } else if message.contains("no such file") || message.contains("not found") {
        "missing_object"
    } else if message.contains("corrupt")
        || message.contains("invalid")
        || message.contains("manifest")
    {
        "corrupt_or_format"
    } else if message.contains("timeout") {
        "timeout"
    } else if message.contains("durability") {
        "durability"
    } else if code == "LIX_READ_FULFILLMENT_INVALID" {
        "read_fulfillment_invalid_unclassified"
    } else {
        "other"
    }
}

fn safe_payload_diagnostics(error: &lix_sdk::LixError) -> String {
    let details = error.details.as_deref();
    let safe_enum = |key: &str, allowed: &[&str]| {
        details
            .and_then(|details| details.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| allowed.contains(value))
            .unwrap_or("unknown")
    };
    let safe_bool = |key: &str| {
        details
            .and_then(|details| details.get(key))
            .and_then(serde_json::Value::as_bool)
    };
    let source_commit_id = details
        .and_then(|details| details.get("sourceCommitId"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .map_or_else(|| "unknown".to_owned(), |id| id.to_string());
    let change_id = details
        .and_then(|details| details.get("changeId"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .map_or_else(|| "unknown".to_owned(), |id| id.to_string());
    serde_json::json!({
        "payloadStandaloneStatus": safe_enum(
            "payloadStandaloneStatus",
            &["absent", "identity_mismatch", "missing_snapshot", "lifetime_mismatch", "matched"],
        ),
        "payloadPhysicalStatus": safe_enum(
            "payloadPhysicalStatus",
            &["absent", "identity_mismatch", "missing_snapshot", "lifetime_mismatch", "matched"],
        ),
        "payloadFailureReason": safe_enum(
            "payloadFailureReason",
            &[
                "selected_change_payload_unavailable",
                "selected_change_payload_recipe_mismatch",
                "selected_change_payload_identity_or_lifetime_mismatch",
                "selected_change_payload_locator_missing",
                "selected_change_payload_source_mismatch",
                "selected_change_payload_outside_descriptor_scope",
                "read_fulfillment_resident_input_conflict",
                "read_fulfillment_validation_failed",
                "read_fulfillment_install_failed",
            ],
        ),
        "payloadPhase": safe_enum(
            "payloadPhase",
            &[
                "pre_request_catalog",
                "read_fulfillment_validation",
                "read_fulfillment_install",
            ],
        ),
        "payloadOperation": safe_enum(
            "payloadOperation",
            &["registered_schema_identity_scan", "registered_schema_snapshot_load"],
        ),
        "payloadSourceDeferred": safe_bool("payloadSourceDeferred"),
        "payloadPhysicalConflict": safe_bool("payloadPhysicalConflict"),
        "sourceCommitId": source_commit_id,
        "changeId": change_id,
    })
    .to_string()
}

async fn run_cold_global_queries<S>(
    replica: &lix_sdk::Lix<S>,
    failure_stage: &mut &'static str,
) -> anyhow::Result<()>
where
    S: lix_sdk::storage::Storage + Clone + Send + Sync + 'static,
{
    *failure_stage = "global_session_open";
    let global = replica
        .open_another_session()
        .with_branch(lix_sdk::GLOBAL_BRANCH_ID)
        .await?;
    let branch_result = async {
        *failure_stage = "default_branch_query";
        let rows = global
            .execute(
                "SELECT value FROM lix_key_value WHERE key = $1 AND lixcol_file_id IS NULL AND lixcol_untracked = false",
                &[lix_sdk::Value::Text("lix_default_branch_id".to_owned())],
            )
            .await?;
        anyhow::ensure!(rows.rows().len() == 1, "unexpected default-branch cardinality");
        let branch_value = rows.rows()[0].get::<serde_json::Value>("value")?;
        let branch_id = branch_value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("default branch JSON value is not a string"))?;
        anyhow::ensure!(
            uuid::Uuid::parse_str(&branch_id)?.to_string() == branch_id,
            "default branch ID was not canonical"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if branch_result.is_ok() {
        *failure_stage = "global_session_close";
    }
    let global_close = global.close().await;
    branch_result?;
    global_close?;

    *failure_stage = "account_session_open";
    let accounts_session = replica
        .open_another_session()
        .with_branch(lix_sdk::GLOBAL_BRANCH_ID)
        .await?;
    *failure_stage = "account_query";
    let accounts_result = accounts_session
        .execute(
            "SELECT id FROM lix_account WHERE lixcol_untracked = false LIMIT 10",
            &[],
        )
        .await
        .map(|rows| rows.rows().len())
        .map_err(anyhow::Error::from);
    if accounts_result.is_ok() {
        *failure_stage = "account_session_close";
    }
    let accounts_close = accounts_session.close().await;
    let account_rows = accounts_result?;
    accounts_close?;
    eprintln!("offline_clone_probe default_branch=ok global_accounts_rows={account_rows}");
    Ok(())
}

async fn handle_protocol_request(
    State(protocol): State<LixServerProtocol<SlateDB>>,
    request: Request<Body>,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let route_class = safe_route_class(parts.uri.path());
    let trace_read_fulfillment = parts.method == Method::POST && route_class == "read_fulfillment";
    eprintln!(
        "offline_clone_probe protocol_request method={} route={route_class}",
        safe_method_class(&parts.method)
    );
    let body = match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Body::empty())
                .unwrap();
        }
    };
    if trace_read_fulfillment {
        eprintln!(
            "offline_clone_probe request {}",
            safe_read_request_summary(&body)
        );
    }
    let request = Request::from_parts(parts, ServerProtocolBody::from(body));
    let response = protocol
        .handle(request, ServerProtocolContext::anonymous())
        .await
        .map(Body::new);
    if !trace_read_fulfillment {
        return response;
    }
    let (parts, body) = response.into_parts();
    let body = match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => {
            eprintln!("offline_clone_probe response body_read=failed");
            return Response::from_parts(parts, Body::empty());
        }
    };
    eprintln!(
        "offline_clone_probe protocol_response route={route_class} status={} {}",
        parts.status.as_u16(),
        if trace_read_fulfillment {
            safe_read_response_summary(&body)
        } else {
            "summary=omitted".to_owned()
        }
    );
    Response::from_parts(parts, Body::from(body))
}

fn safe_method_class(method: &Method) -> &'static str {
    if method == Method::GET {
        "get"
    } else if method == Method::POST {
        "post"
    } else if method == Method::DELETE {
        "delete"
    } else {
        "other"
    }
}

fn safe_route_class(path: &str) -> &'static str {
    [
        ("/sync/read-fulfillment", "read_fulfillment"),
        ("/sync/native-metadata", "native_metadata"),
        ("/sync/native-objects", "native_objects"),
        ("/sync/native-object-range", "native_object_range"),
        ("/sync/native-metadata-walk", "native_metadata_walk"),
        ("/sync/partial-replica-descriptor", "partial_descriptor"),
        ("/sync/partial-replica-admission", "partial_admission"),
    ]
    .into_iter()
    .find_map(|(suffix, class)| path.ends_with(suffix).then_some(class))
    .unwrap_or("other")
}

const TARGET_CHANGE_ID: &str = "01a08d1c-00ef-75b1-b882-65a36ff3d44e";

fn safe_read_request_summary(bytes: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return "json=invalid".to_owned();
    };
    let interests = value
        .get("interests")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut kinds = std::collections::BTreeSet::new();
    let mut registered_schema_exact_rows = 0usize;
    let mut registered_schema_scan_filters = 0usize;
    let mut scan_shapes = Vec::new();
    for interest in &interests {
        if let Some(kind) = interest.get("kind").and_then(serde_json::Value::as_str) {
            if [
                "scan",
                "exact",
                "collection_generation",
                "packed_identity_membership",
                "filesystem_metadata",
                "filesystem_paths",
                "file_content",
                "diff",
            ]
            .contains(&kind)
            {
                kinds.insert(kind);
            }
        }
        if interest.get("kind").and_then(serde_json::Value::as_str) == Some("exact") {
            registered_schema_exact_rows += interest
                .get("rows")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|row| {
                    row.get("schemaKey").and_then(serde_json::Value::as_str)
                        == Some("lix_registered_schema")
                })
                .count();
        }
        if interest.get("kind").and_then(serde_json::Value::as_str) == Some("scan") {
            let request = interest.get("request");
            let filter = request.and_then(|request| request.get("filter"));
            let keys = json_field(filter, "schema_keys", "schemaKeys")
                .and_then(serde_json::Value::as_array);
            let schema_catalog = keys.is_some_and(|keys| {
                keys.iter()
                    .any(|key| key.as_str() == Some("lix_registered_schema"))
            });
            if schema_catalog {
                registered_schema_scan_filters += 1;
            }
            let branch_ids =
                json_field(filter, "branch_ids", "branchIds").and_then(serde_json::Value::as_array);
            let selected_branch = value
                .pointer("/descriptor/selectedBranch/branchId")
                .and_then(serde_json::Value::as_str);
            let global_branch = value
                .pointer("/descriptor/globalBranch/branchId")
                .and_then(serde_json::Value::as_str);
            let branch_selected = branch_ids.is_some_and(|branches| {
                branches.len() == 1
                    && branches[0].as_str().is_some_and(|branch| {
                        selected_branch == Some(branch) || global_branch == Some(branch)
                    })
            });
            let file_ids =
                json_field(filter, "file_ids", "fileIds").and_then(serde_json::Value::as_array);
            let file_null_only = file_ids.is_some_and(|files| {
                files.len() == 1
                    && (files[0].as_str() == Some("Null") || files[0].as_str() == Some("null"))
            });
            let columns = request
                .and_then(|request| request.get("projection"))
                .and_then(|projection| json_field(Some(projection), "columns", "columns"))
                .and_then(serde_json::Value::as_array);
            let row_pk_only = columns
                .is_some_and(|columns| columns.len() == 1 && columns[0].as_str() == Some("row_pk"));
            scan_shapes.push(serde_json::json!({
                "domainClass": match interest.get("domain").and_then(serde_json::Value::as_str) {
                    Some("tracked") => "tracked",
                    Some("untracked") => "untracked",
                    Some("combined") => "combined",
                    _ => "unknown",
                },
                "schemaCatalog": schema_catalog,
                "branchDescriptorScoped": branch_selected,
                "fileNullOnly": file_null_only,
                "untrackedScope": match json_field(filter, "untracked", "untracked").and_then(serde_json::Value::as_bool) {
                    Some(false) => "tracked_only",
                    Some(true) => "untracked_only",
                    None => "unspecified",
                },
                "rowPkOnly": row_pk_only,
                "rowFilterAll": json_field(filter, "rows", "rows").and_then(serde_json::Value::as_str).is_some_and(|v| v == "All" || v == "all"),
                "rowKeysEmpty": json_field(filter, "row_pks", "rowPks").and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty),
                "noLimit": request.and_then(|request| json_field(Some(request), "limit", "limit")).is_none_or(serde_json::Value::is_null),
            }));
        }
    }
    let target_id_mentioned = contains_exact_string(&value, TARGET_CHANGE_ID);
    serde_json::json!({
        "interestCount": interests.len(),
        "interestKinds": kinds,
        "registeredSchemaExactRows": registered_schema_exact_rows,
        "registeredSchemaScanFilters": registered_schema_scan_filters,
        "scanShapes": scan_shapes,
        "targetChangeIdMentioned": target_id_mentioned,
    })
    .to_string()
}

fn json_field<'a>(
    value: Option<&'a serde_json::Value>,
    snake_case: &str,
    camel_case: &str,
) -> Option<&'a serde_json::Value> {
    value.and_then(|value| value.get(snake_case).or_else(|| value.get(camel_case)))
}

fn safe_read_response_summary(bytes: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return "json=invalid".to_owned();
    };
    let mut inputs = Vec::new();
    collect_inputs(&value, &mut inputs);
    let mut change_record_count = 0usize;
    let mut target_change_record = false;
    let mut target_change_locator = false;
    let error = value.get("error");
    let error_code = error
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_str)
        .filter(|code| ["LIX_READ_FULFILLMENT_INVALID", "LIX_INVALID_ARGUMENT"].contains(code))
        .unwrap_or("unknown");
    let error_reason = error
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str)
        .map(safe_read_validation_reason)
        .unwrap_or("none");
    for input in inputs {
        let Some(address) = input.get("address") else {
            continue;
        };
        let Some(kind) = address.get("kind").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let payload_address = address.get("address");
        if kind == "change_record" {
            change_record_count += 1;
            target_change_record |= payload_address
                .and_then(|address| address.get("changeId"))
                .and_then(serde_json::Value::as_str)
                == Some(TARGET_CHANGE_ID);
        } else if kind == "metadata"
            && payload_address
                .and_then(|address| address.get("kind"))
                .and_then(serde_json::Value::as_str)
                == Some("change_locator")
        {
            target_change_locator |= payload_address
                .and_then(|address| address.get("changeId"))
                .and_then(serde_json::Value::as_str)
                == Some(TARGET_CHANGE_ID);
        }
    }
    serde_json::json!({
        "errorCode": error_code,
        "errorReason": error_reason,
        "changeRecordCount": change_record_count,
        "targetChangeRecord": target_change_record,
        "targetChangeLocator": target_change_locator,
    })
    .to_string()
}

fn safe_read_validation_reason(message: &str) -> &'static str {
    if message.contains("canonical change payload has no matching exact row recipe") {
        "change_payload_not_selected_by_exact_recipe"
    } else if message.contains("canonical change payload is outside the descriptor branch scope") {
        "change_payload_outside_descriptor_branches"
    } else if message.contains("canonical change payload has no selected source locator") {
        "change_payload_missing_locator"
    } else if message.contains("canonical change payload source disagrees") {
        "change_payload_source_disagrees_with_locator"
    } else if message.contains("descriptor branches") {
        "catalog_branch_outside_descriptor"
    } else if message.contains("historical diff recipes") {
        "historical_diff_requires_separate_discovery"
    } else if message.contains("duplicate required read input") {
        "duplicate_required_input"
    } else if message.contains("canonical change payloads are selected") {
        "change_record_cannot_be_required_directly"
    } else if message.contains("invalid read fulfillment request") {
        "invalid_request_bounds_or_descriptor"
    } else if message.contains("invalid read continuation") {
        "invalid_continuation"
    } else if message.contains("invalid required address") {
        "invalid_required_address"
    } else {
        "other_validation_rejection"
    }
}

fn collect_inputs<'a>(value: &'a serde_json::Value, result: &mut Vec<&'a serde_json::Value>) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(inputs) = object.get("inputs").and_then(serde_json::Value::as_array) {
                result.extend(inputs);
            }
            for (key, child) in object {
                if key != "inputs" {
                    collect_inputs(child, result);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                collect_inputs(child, result);
            }
        }
        _ => {}
    }
}

fn contains_exact_string(value: &serde_json::Value, expected: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == expected,
        serde_json::Value::Object(object) => object
            .values()
            .any(|child| contains_exact_string(child, expected)),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|child| contains_exact_string(child, expected)),
        _ => false,
    }
}

fn copy_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target);
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target).unwrap();
        } else {
            panic!("physical clone contains a non-regular filesystem entry");
        }
    }
}
