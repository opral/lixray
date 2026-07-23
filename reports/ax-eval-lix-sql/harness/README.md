# Ax-eval harness

The runner stores each invocation under a unique ID and each repetition under
`repetition-NNN`. It also writes a unique run index plus a per-kind latest
pointer. Capture the unique index path printed on stdout and pass that exact
path to the judge. Each judge pass receives its own invocation ID, judgment
directory, and immutable index, so rejudging a run cannot replace prior
verdicts. The judge still supports existing flat single-run inputs, and the
metrics extractor remains compatible with existing schema-2 judge artifacts.

The production snapshot is `data/descriptions/production-v5.txt`; the
`production-hard-cut-v5` arm reads it without touching it during normal runs.
To inspect the frozen descriptor without starting an eval:

```sh
node reports/ax-eval-lix-sql/harness/run-evals.mjs \
  production-hard-cut-v5 --prepare-descriptions-only
```

Add `--refresh-description` only when intentionally freezing a new worktree
descriptor into the snapshot.

## Prepare the pinned Lix SDK

The reported rounds ran against Lix
`8649dad564589d69848b933453493eee8a634b71`. Build that exact SDK in an
isolated worktree before running the harness:

```sh
AX_EVAL_LIX_WORKTREE="$(mktemp -d)"
git -C vendor/lix worktree add --detach \
  "$AX_EVAL_LIX_WORKTREE" \
  8649dad564589d69848b933453493eee8a634b71
npm --prefix "$AX_EVAL_LIX_WORKTREE/packages/js-sdk" ci
npm --prefix "$AX_EVAL_LIX_WORKTREE/packages/js-sdk" run build:native
npm --prefix "$AX_EVAL_LIX_WORKTREE/packages/js-sdk" run build:ts
export AX_EVAL_LIX_SDK_ENTRY="$AX_EVAL_LIX_WORKTREE/packages/js-sdk/dist/index.js"
```

Run the deterministic harness contract probes with:

```sh
node --test \
  reports/ax-eval-lix-sql/harness/wire-values.test.mjs \
  reports/ax-eval-lix-sql/harness/judge-artifacts.test.mjs
```

Run the catalog conformance probe with:

```sh
node reports/ax-eval-lix-sql/harness/probe-catalog.mjs
```

## Smoke test

From the repository root:

```sh
SMOKE_RUN_INDEX="$(
  AX_EVAL_NATIVE_BATCH=1 \
  AX_EVAL_CONCURRENCY=1 \
  node reports/ax-eval-lix-sql/harness/run-evals.mjs \
    production-hard-cut-v5 --task=direct-docs --repetitions=1
)"

SMOKE_JUDGE_INDEX="$(
  AX_EVAL_JUDGE_CONCURRENCY=1 \
  node reports/ax-eval-lix-sql/harness/judge-evals.mjs \
    production-hard-cut-v5 --repetitions=1 \
    --run-index="$SMOKE_RUN_INDEX"
)"
```

## Ten-repetition production regression

```sh
SCORED_RUN_INDEX="$(
  AX_EVAL_NATIVE_BATCH=1 \
  AX_EVAL_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/run-evals.mjs \
    production-hard-cut-v5 --repetitions=10
)"

SCORED_JUDGE_INDEX="$(
  AX_EVAL_JUDGE_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/judge-evals.mjs \
    production-hard-cut-v5 --repetitions=10 \
    --run-index="$SCORED_RUN_INDEX"
)"
```

This produces 90 scored sessions and 90 independent judgments.

## Three-repetition holdouts

```sh
HOLDOUT_RUN_INDEX="$(
  AX_EVAL_NATIVE_BATCH=1 \
  AX_EVAL_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/run-evals.mjs \
    production-hard-cut-v5 --holdouts-only --repetitions=3
)"

HOLDOUT_JUDGE_INDEX="$(
  AX_EVAL_JUDGE_CONCURRENCY=3 \
  node reports/ax-eval-lix-sql/harness/judge-evals.mjs \
    production-hard-cut-v5 --holdouts-only --repetitions=3 \
    --run-index="$HOLDOUT_RUN_INDEX"
)"
```

This produces 18 holdout sessions and 18 independent judgments. Run the
extractor after both judge passes:

```sh
python3 reports/ax-eval-lix-sql/harness/extract-metrics.py \
  --scored-run-index="$SCORED_RUN_INDEX" \
  --scored-judge-index="$SCORED_JUDGE_INDEX" \
  --holdout-run-index="$HOLDOUT_RUN_INDEX" \
  --holdout-judge-index="$HOLDOUT_JUDGE_INDEX"
```

`data/results.json` retains every singleton and repeated run, and adds round
and per-task aggregates for scored and holdout sessions. Nested smoke or rerun
artifacts are excluded unless their unique indexes are passed explicitly.
