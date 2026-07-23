# Lix SQL API agent-experience evaluation

- Date: 2026-07-23
- Evaluated LixRay baseline: `a97ae971024090385098f716d524c331f55689cb`
- Evaluated Lix runtime: `8649dad564589d69848b933453493eee8a634b71`
- Current `origin/main` at finalization: `20129e1` with Lix `9c0f9ce6` (not the evaluated baseline)
- Native addon SHA-256: `87dfcf27339fa8589f925908e7d7b2df84903fb98756ce6d1985261dd536c3ce`

## Decision

Ship the hard-cut MCP contract: the 2,098-character `production-hard-cut-v5` guide, native JSON ordinary scalars, and explicit wrappers only for BLOB, SQL JSON, and the SQL REAL input escape.

The repeated production round completed 90/90 scored runs with zero failed SQL/tool calls. Across ten fresh runs of each of nine tasks, median duration was 18.0 seconds, median tool use was two calls, and each dynamic-entity run fetched one schema row. The frozen guide exactly matches production and has SHA-256 `d7798094ea83936e7a8aa5445f20dc38a31861c7fa4ea4ec81d9b175c683d57f`.

The repeated holdout result is 15/18 under strict final-answer judgment, with five of six fixtures perfect across all three repetitions. All three misses were the deleted-file-history fixture. Its SQL traces correctly recovered stable identity, tombstone, and two retained versions without errors; the final prose omitted explicitly required null/path fields. Keep those judgments as failures. The same criteria accepted a materially similar v4 singleton answer, so the cluster also demonstrates judge-policy sensitivity. It is not evidence for another prompt tweak or a Lix query fix.

Two Lix-level inconsistencies are worth hard cuts:

1. `information_schema.columns` should publish legal Lix SQL type names and semantic nullability, not Arrow/provider details.
2. Every history surface should share one metadata, scoping, identity, and tombstone contract.

The remaining registry, branch, filesystem, and error-shape work is P1. In particular, the newer Lix commit now pinned by `origin/main` adds `lix_active_branch_id()`; that improvement was not present in the evaluated runtime and should be re-evaluated before removing the corresponding MCP tool.

## Production repeat

### Aggregate

| Surface                          | Runs | Strict success | Duration p25 / median / p75 | Median calls | Total calls | Execute calls | Failed calls              | Schema rows | Median input | Median output | Median AX |
| -------------------------------- | ---: | -------------: | --------------------------: | -----------: | ----------: | ------------: | ------------------------- | ----------: | -----------: | ------------: | --------: |
| `production-hard-cut-v5` scored  |   90 |          90/90 |         15.4 / 18.0 / 21.4s |            2 |         231 |           119 | 0                         |          10 |       40,243 |         341.5 |        99 |
| `production-hard-cut-v5` holdout |   18 |          15/18 |         22.7 / 25.5 / 34.4s |            3 |          59 |            35 | 3 expected / 0 unexpected |          18 |     52,375.5 |         592.5 |        98 |

The three holdout errors are the expected failing statement in the atomic-rollback fixture, once per repetition. There were no unexpected holdout errors. SQL/state audit found correct query-state recovery in 18/18 holdouts, including rollback verification; 15/18 is the unmodified answer-level judge score.

AX remains a weak discriminator: the three strictly failed deleted-history answers still received AX 98, comparable to passing holdouts. Strict fixture judgment, failed SQL, tool calls, and discovery volume are the product metrics to follow.

### Scored tasks, ten repetitions each

| Task                        | Strict success | Duration p25 / median / p75 | Median calls | Errors |
| --------------------------- | -------------: | --------------------------: | -----------: | -----: |
| Atomic multi-read           |          10/10 |         15.7 / 16.9 / 20.9s |            2 |      0 |
| BLOB text search            |          10/10 |         15.1 / 15.9 / 18.0s |            2 |      0 |
| Branch comparison           |          10/10 |         15.4 / 17.6 / 18.6s |            2 |      0 |
| Branch-only files           |          10/10 |         19.4 / 20.9 / 25.4s |            4 |      0 |
| Direct documents            |          10/10 |         12.0 / 13.3 / 13.7s |            2 |      0 |
| Directory aggregation       |          10/10 |         14.5 / 16.8 / 17.9s |            2 |      0 |
| Dynamic tasks               |          10/10 |         18.3 / 23.5 / 26.2s |            3 |      0 |
| File history                |          10/10 |         23.7 / 26.7 / 30.3s |            4 |      0 |
| Recent application activity |          10/10 |         16.0 / 16.9 / 17.9s |            2 |      0 |

All 90 runs began with `list_workspaces`. The dynamic task accounts for all ten schema probes and all ten returned schema rows. This confirms that the registry recipe removes broad catalog discovery without overfitting to one run.

### Holdouts, three repetitions each

| Task                               | Strict success | Duration p25 / median / p75 | Median calls |     Errors |
| ---------------------------------- | -------------: | --------------------------: | -----------: | ---------: |
| Atomic write rollback              |            3/3 |         23.9 / 25.2 / 25.5s |            3 | 3 expected |
| Composite-key entity history       |            3/3 |         25.4 / 27.0 / 35.8s |            4 |          0 |
| DataFusion calendar grouping       |            3/3 |         20.4 / 22.0 / 22.4s |            3 |          0 |
| Deleted-file history               |            0/3 |         33.6 / 35.2 / 35.5s |            4 |          0 |
| Literal `%` / `_` path aggregation |            3/3 |         20.4 / 21.1 / 47.0s |            2 |          0 |
| Renamed-file history               |            3/3 |         27.4 / 31.5 / 36.6s |            4 |          0 |

The deleted-history distinction matters:

- Repetitions 1 and 2 returned the exact three SQL rows but summarized the tombstone as “Deleted” instead of explicitly printing `path = null` and `data = null`.
- Repetition 3 explicitly described the null tombstone but omitted `/notes/deleted.md` from the two retained content states.
- None guessed, retried, hit a SQL error, or lost the deleted file's stable identity.

These are strict response-completeness failures, not failures of Lix history logic. The same fixture criteria accepted a materially similar v4 answer that said “deleted” and presented the retained bodies under a global path, while v5 repetition 3 explicitly said the tombstone fields were null and still failed because it did not repeat the path beside both bodies. Preserve the raw 15/18 result with no manual override, but interpret the cluster as answer-format/judge-policy sensitivity. Do not add fixture-specific prose to the MCP description.

## Historical selection evidence

All five clean selection arms ran in the same Bubblewrap-isolated, MCP-only environment. Agents could not access the repository, prior transcripts, shell, web, apps, plugins, or shared temporary worktrees.

| Round                | Guide / wire format     | Success | Duration p25 / median / p75 | Median calls | Total calls | Failed SQL | Schema rows | Median input | Median output | Median AX |
| -------------------- | ----------------------- | ------: | --------------------------: | -----------: | ----------: | ---------: | ----------: | -----------: | ------------: | --------: |
| `baseline-clean`     | 2,430 chars / tagged    |     9/9 |         18.2 / 19.3 / 23.4s |            3 |          31 |          1 |          68 |       55,355 |           464 |        98 |
| `hard-cut-v1`        | 3,075 chars / tagged    |     9/9 |         16.8 / 19.6 / 24.4s |            3 |          28 |          0 |          50 |       51,853 |           424 |        99 |
| `lean-tagged-v2`     | 2,039 chars / tagged    |     9/9 |         12.4 / 22.2 / 24.8s |            2 |          26 |          1 |           1 |       40,156 |           355 |        99 |
| `lean-primitive-v3`  | 2,039 chars / primitive |     9/9 |         14.7 / 19.3 / 20.6s |            2 |          23 |          1 |           1 |       39,920 |           315 |        99 |
| `ideal-primitive-v4` | 2,096 chars / primitive |     9/9 |         14.9 / 16.3 / 19.3s |            2 |          24 |          0 |           1 |       40,053 |           389 |        99 |

Against the clean baseline, the selected v4 arm kept 9/9 completion while producing:

- 15.5% lower median duration: 19.3 → 16.3 seconds;
- 22.6% fewer total tool calls: 31 → 24;
- 27.8% fewer execute calls: 18 → 13;
- zero failed SQL calls instead of one;
- 98.5% fewer schema rows: 68 → 1;
- 27.6% lower median cumulative input: 55,355 → 40,053 tokens;
- 16.2% lower median output: 464 → 389 tokens.

Those paired-arm deltas remain directional because there was one run per task and arm. The 90-run v5 round adds confidence in completion and error rates; it is not a randomized latency comparison against the baseline.

### What each iteration taught us

The baseline was already capable, but its TODO-line agent tried PostgreSQL-style `regexp_split_to_table`, `convert_from`, and `WITH ORDINALITY` before recovering. It also scanned all tables and then 68 column rows to find one application entity.

P0 named Apache DataFusion and supplied exact Lix recipes. That removed the SQL failure, but expanding the guide from 2,430 to 3,075 characters did not improve median duration or calls. Agents followed the generic schema examples into five probes and 50 returned rows.

Lean v2 removed the generic request/response example, broad `information_schema` recipe, and material already present in JSON Schema. Discovery fell to one application schema row. The cut also exposed one real omission: both lean arms guessed nonexistent `lixcol_commit_id`, failed once, and recovered with `lixcol_observed_commit_id`.

Primitive v3 replaced tagged NULL, Boolean, integer, real, and text cells with ordinary JSON values. BLOB and SQL JSON stayed tagged. Over 429 captured result cells, this reduced serialized result characters from 19,570 to 10,138, or 48.2%. Tagged and primitive median model input stayed nearly equal, so the win is envelope simplicity and explicit agent preference, not a claimed reasoning-cost reduction.

Ideal v4 restored 57 characters naming `lixcol_depth`, `lixcol_observed_commit_id`, and `lixcol_commit_created_at`, plus the explicit absence of `lixcol_commit_id`. That removed the lean rounds' only SQL retry. Production v5 made only the factually necessary two-character net correction from “all history” to “typed history”; the query recipes did not change.

## What agents found intuitive

Only reflection prompts support qualitative claims.

- One agent said, “The API's schema discovery and parameterized SQL felt intuitive.”
- The direct-child agent found the `lix_file` / `lix_directory` relationship precise.
- The history agent found the explicit active-branch model understandable.
- Primitive-arm agents described workspace discovery, active-branch lookup, schema inspection, and direct SQL execution as clearly separated.
- One primitive reflection called the old tagged positional cells “slightly cumbersome.”

Observed behavior supports those statements:

- direct-child reads completed in one execute call;
- all ten repeated dynamic tasks found only the needed application schema;
- two ordered reads worked in one atomic execute call;
- cross-branch comparisons used `_by_branch` without changing workspace data;
- file, directory, branch, activity, entity, and history questions all fit one SQL surface.

## Hard Lix cuts

### P0 — make `information_schema` an executable contract

This is a hard inconsistency, not a documentation problem. Eval traces show `data_type` values such as `Utf8`, `LargeBinary`, and `Int64`: Arrow implementation names rather than the legal type vocabulary agents should write in Lix SQL. A replay on the pinned runtime confirmed that `CAST(... AS Utf8)`, `LargeBinary`, and `Int64` are all rejected while canonical `TEXT` and `BIGINT` are accepted; there is currently no accepted public binary cast corresponding to `LargeBinary`.

Nullability is similarly ambiguous. The catalog reports `lix_file.id` as nullable, but explicitly inserting NULL generates a non-null ID; history correctly needs nullable path/data for tombstones. One provider-derived flag cannot safely stand in for both result nullability and write/default behavior.

Hard cut:

- emit canonical SQL spellings for every column;
- add binder support for every advertised type, including binary;
- make `is_nullable` reflect the actual surface contract, including history tombstones;
- add conformance tests that every advertised type is accepted by the SQL binder and every nullability claim matches reads/writes;
- stop exposing provider-specific type strings as the public catalog contract.

This would make targeted `information_schema.columns` useful again. It should not restore broad schema scans to the MCP prompt.

### P0 — one history model

History currently requires Lix-specific knowledge in four dimensions:

- mandatory start-head scoping;
- stable user identity rather than current path;
- a metadata vocabulary different from active tables;
- typed `_history` and `lix_state_history` not sharing one exact shape.

The lean arms' duplicate `lixcol_commit_id` failure is direct evidence. The guide now prevents it, but the engine surface should not require a memorized exception.

Across the repeated suite, history took four median calls. Eight otherwise successful traces received `LIX_HISTORY_NON_IDENTITY_FILTER` notices—four scored file-history runs, all three deleted-history runs, and one renamed-history run—and every agent recovered. The notice is useful, but repeated recovery is evidence that the query shape is not self-evident.

Hard cut:

- give every history surface the same start, revision, chronology, depth, identity, and tombstone columns;
- choose one commit/revision vocabulary and remove aliases rather than documenting per-table exceptions;
- default history reads to the active branch head, while retaining an explicit start-commit override for cross-branch/time-travel work;
- expose primary-key metadata directly so composite identity is queryable without reverse-engineering JSON Schema;
- guarantee that the same identity query includes renames and tombstones on every typed surface.

Keep the three deleted-history judgments unchanged: they show an answer-presentation miss after correct SQL, not a reason to weaken this contract.

### P1 — semantic registry projection

`lix_registered_schema` was reliable: dynamic entities passed 10/10 with one returned schema per run. The remaining tax is having to call `lix_json_get_text` and interpret JSON Schema to recover table and primary-key metadata.

Unqualified entity `SELECT *` is also noisy: the evaluated dynamic table has five user columns and exposes eleven additional `lixcol_*` columns. The semantic registry should identify user columns directly so agents do not need to infer that boundary from names.

Add one authoritative read-only projection such as:

`table_name, primary_key_columns, json_schema, has_by_branch, has_history`

The registry and SQL catalog must not disagree. This is a smaller, more future-proof discovery surface than listing every system table.

### P1 — branches

At the evaluated runtime, agents called MCP `active_branch_id` 28 times; 18 returned values were never used. The other ten uses were in branch work that can move into SQL. The newer `origin/main` pins Lix `9c0f9ce66f1cb06eaf4778f2cf0d9031ab271675`, which adds `lix_active_branch_id()`. That directly addresses the missing in-SQL branch identifier and is not an outstanding engine cut.

Adopt that runtime, re-run branch tasks, then consider removing MCP `active_branch_id`. Keep `switch_branch` for stateful branch work; read-only comparisons should continue to use `_by_branch`.

### P1 — filesystem projection

Agents explicitly found the current file/directory relationship intuitive, and repeated file/directory tasks were perfect. The remaining papercuts are separate tables, trailing-slash conventions, and prefix-based recursive descendants.

Do not replace the proven core tables without a new failing eval. A compatible projection with `path`, `kind`, `parent_path`/`parent_id`, and nullable `data` could simplify natural filesystem questions while preserving `lix_file` and `lix_directory` as mutation surfaces.

### P1 — total ordering for activity

Six of ten repeated recent-activity queries used only `ORDER BY created_at DESC`; five of those six result sets contained equal timestamps. They happened to return the expected order, so the strict eval passed, but `created_at` is demonstrably not a total order.

Expose a monotonic change sequence, or formally guarantee and document a canonical `(created_at, id)` ordering. This belongs in Lix rather than another MCP prompt recipe.

### P1 — structured SQL errors

Failed execute calls currently surface DataFusion text, for example a parser string or “No field named …” followed by all valid fields. Agents can recover, but clients must parse prose.

Return a stable structured error:

`code, category, statement_index, message, hint, retryable, details`

For atomic batches, `statement_index` is essential. Preserve the readable message, but make recovery depend on fields rather than DataFusion wording.

## What did not improve the evals

### Exhaustive static schema

The first-generation 20,523-character, 48-surface schema achieved 9/9, but so did every compact isolated arm. It fetched 1,500 schema rows and used 109,444 median cumulative input tokens. Static exhaustiveness cannot describe future workspace entities and does not teach operational Lix invariants. Do not restore it.

### More examples and generic SQL help

P0's full tagged request/response example and fallback `information_schema.columns` block increased description size without improving median duration or calls. Apache DataFusion identifies the general dialect. The guide should contain only Lix-specific invariants and recipes.

### Cutting all history details

Removing exact metadata caused the same history failure in both lean arms. Restoring one 57-character sentence was the right trade. Further prompt cutting would remove facts already shown to matter.

### Treating strict holdout misses as prompt failures

The three repeated deleted-history traces were SQL-correct. Adding fixture-specific “always print null path/data” prose would optimize the judge rather than the API. Keep the strict score, but do not change the guide.

### Removing the whole control surface

At the evaluated runtime, `list_workspaces`, `active_branch_id`, `switch_branch`, and `execute` each had a distinct role. Only `active_branch_id` is now a plausible removal candidate, because newer Lix adds an equivalent SQL UDF; validate it first.

## Production MCP hard cut

The implemented public contract is intentionally breaking:

- ordinary SQL parameters and result cells are native JSON `null`, Boolean, number, or string;
- BLOB stays `{ "kind": "blob", "base64": "..." }`;
- SQL JSON stays `{ "kind": "json", "value": ... }`, avoiding collisions with BLOB-shaped JSON;
- legacy tagged scalar inputs are rejected;
- BLOB input must be canonical standard base64;
- unsafe-magnitude native numeric inputs are rejected;
- `{ "kind": "float", "value": n }` explicitly preserves an integral or large SQL REAL parameter;
- raw execute is now correctly annotated `destructiveHint: true`;
- columns plus positional rows, duplicate-column fidelity, ordered batch results, `rowsAffected`, and notices are unchanged;
- LixRay's internal runtime/file-service transport stays typed; conversion occurs only at the MCP boundary.

Native JSON cannot distinguish integer `1` from real `1.0`: both serialize as the same JSON number. On input, an unwrapped integral number becomes SQL INTEGER, while `{ "kind": "float", "value": 1 }` forces SQL REAL; this matters for expressions such as division. On output, SQL INTEGER `1` and SQL REAL `1.0` both intentionally become JSON `1`, so consumers that need type identity must obtain it from schema/query context.

The generated execute descriptor changed as follows:

| Component       | Baseline | Hard cut | Change |
| --------------- | -------: | -------: | -----: |
| Full descriptor |    6,532 |    5,648 | −13.5% |
| Description     |    2,430 |    2,098 | −13.7% |
| Input schema    |    1,705 |    1,686 |  −1.1% |
| Output schema   |    2,004 |    1,478 | −26.2% |

The input schema retains more bytes than the first primitive prototype because it now documents and validates the REAL escape, safe numeric magnitude, and canonical base64. That is intentional correctness material, not prompt prose.

The behavioral tasks exercised the primitive scalar envelope but did not distinguish integral SQL REAL from INTEGER or submit malformed base64. Those two safeguards are supported by production protocol/unit tests, not by the AX success rate.

[execute-schema.ts](../../web-app/src/mcp/execute-schema.ts) contains the frozen guide. [server.ts](../../web-app/src/mcp/server.ts) implements the boundary conversion and validation. [mcp-tools.json](../../web-app/mcp-tools.json) is the generated public artifact.

At report time:

- `pnpm --dir web-app exec tsc --noEmit --pretty false` exits successfully;
- the complete MCP/worker command passes 113/113 tests under Node 24.4.1 after rebasing onto `origin/main`;
- protocol coverage includes primitive conversion, the integral-REAL escape, scalar unwrapping, BLOB/JSON preservation, collision safety, canonical base64 rejection, unsafe numbers, legacy-wrapper rejection, ordered batches, notices, destructive annotations, and generated-artifact equality.
- a one-repetition compatibility pass against current Lix `9c0f9ce6` passed all 9/9 scored tasks; it is not mixed into the repeated `8649dad` aggregate.

## Method

The supplied `ax-eval 4` archive contained its skill, schemas, and metric extractor but no prior transcripts or result file, so the behavioral evidence is fresh.

The study has three stages:

1. A 27-run exploratory panel compared minimal, exhaustive, and then-current compact descriptions. Four cells had source/web contamination, so it is used only for broad hypothesis generation.
2. A clean 45-run selection panel compared five isolated arms, plus targeted reflection runs and six frozen v4 holdouts. Baseline/P0 and tagged/primitive pairs were task-first and counterbalanced. V4 was selected adaptively.
3. The exact production-v5 snapshot ran ten times on each of nine scored tasks and three times on each of six holdouts: 108 isolated sessions total.

Each session received a fresh seeded in-memory Lix and could reach only its MCP fixture. Native `executeBatch` was enabled. A separate low-reasoning session of the same model independently judged every transcript against fixture-grounded criteria.

Targeted read-only catalog/cast probes on the same pinned runtime checked the type-vocabulary finding. A disposable in-memory write verified the generated-ID nullability behavior.

All 108 repeated agent processes and all 108 judge processes exited successfully without timeouts. The only failed tool invocations were the three intentional rollback statements.

Manual review did not attempt to re-label all 108 sessions. It covered every failed judgment, the latency outlier, and representative samples across tasks and repetitions. No judgment was manually overridden.

The repeat harness stores invocation-scoped paths and repetition IDs so reruns cannot overwrite evidence. The extractor includes repeated artifacts only through explicit matching run/judge index pairs.

## Limitations

- Historical selection arms have one run per task; their timing/token deltas are directional.
- Ten production repetitions materially strengthen completion/error evidence, but shared infrastructure and concurrent scheduling still limit latency inference.
- The 73-second literal-path outlier was model scheduling/latency, not extra SQL or API recovery.
- Holdouts have only three repetitions per fixture.
- Actor and judge used the same model family, although sessions were independent.
- V4/v5 were selected after inspecting earlier failures.
- The strict judge scores delivered answers, not only SQL correctness, as the deleted-history cluster demonstrates.
- The v4/v5 deleted-history inconsistency shows that answer-level judgments are sensitive to presentation even under the same criteria.
- The repeated study uses Lix `8649dad`. A one-repetition compatibility pass on `9c0f9ce6` passed 9/9 scored tasks and the catalog probe confirmed `lix_active_branch_id()`, but those observations do not replace a repeated current-runtime round.
- Fixtures do not exercise production OAuth, network latency, concurrent clients, large workspaces, access control, or compression.
- Cumulative input tokens include the Codex environment and are comparable only within this harness.

## Reproduce and inspect

The exact selected artifacts are:

- [Machine-readable results](data/results.json)
- [Flat results](data/results.csv)
- [Production-v5 scored run index](data/raw/run-index.scored.production-hard-cut-v5.20260723T140959Z-2224598-3d4a98f2.json)
- [Production-v5 scored judge index](data/judges/judge-index.scored.production-hard-cut-v5.20260723T140959Z-2224598-3d4a98f2.json)
- [Production-v5 holdout run index](data/raw/run-index.holdout.production-hard-cut-v5.20260723T142709Z-2315661-92ad9308.json)
- [Production-v5 holdout judge index](data/judges/holdout/judge-index.holdout.production-hard-cut-v5.20260723T142709Z-2315661-92ad9308.json)
- [Current-Lix compatibility run index](data/raw/run-index.scored.production-hard-cut-v5.20260723T143940Z-2342037-8ac8f954.json)
- [Current-Lix compatibility judge index](data/judges/judge-index.scored.production-hard-cut-v5.20260723T143940Z-2342037-8ac8f954.json)
- [Frozen production-v5 description](data/descriptions/production-v5.txt)
- [Runtime manifest](data/runtime.json)
- [Harness instructions](harness/README.md)
- [Catalog conformance probe](harness/probe-catalog.mjs)
- [Wire-shape measurement](harness/measure-wire-shape.mjs)

From the repository root:

```sh
SCORED_RUN_INDEX="$(
  AX_EVAL_LIX_SDK_ENTRY=/tmp/lixray-lix-8649/packages/js-sdk/dist/index.js \
  AX_EVAL_NATIVE_BATCH=1 AX_EVAL_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/run-evals.mjs \
    production-hard-cut-v5 --repetitions=10
)"
SCORED_JUDGE_INDEX="$(
  AX_EVAL_JUDGE_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/judge-evals.mjs \
    production-hard-cut-v5 --repetitions=10 --run-index="$SCORED_RUN_INDEX"
)"

HOLDOUT_RUN_INDEX="$(
  AX_EVAL_LIX_SDK_ENTRY=/tmp/lixray-lix-8649/packages/js-sdk/dist/index.js \
  AX_EVAL_NATIVE_BATCH=1 AX_EVAL_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/run-evals.mjs \
    production-hard-cut-v5 --holdouts-only --repetitions=3
)"
HOLDOUT_JUDGE_INDEX="$(
  AX_EVAL_JUDGE_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/judge-evals.mjs \
    production-hard-cut-v5 --holdouts-only --repetitions=3 \
    --run-index="$HOLDOUT_RUN_INDEX"
)"

python3 reports/ax-eval-lix-sql/harness/extract-metrics.py \
  --scored-run-index="$SCORED_RUN_INDEX" \
  --scored-judge-index="$SCORED_JUDGE_INDEX" \
  --holdout-run-index="$HOLDOUT_RUN_INDEX" \
  --holdout-judge-index="$HOLDOUT_JUDGE_INDEX"
```
