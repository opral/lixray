# MCP

LixRay exposes Lix through a deliberately small MCP surface. SQL is the
universal interface for repository data; there are no separate file or entity
tools. Lix SQL is a Postgres dialect subset.

## End-to-end trace correlation

MCP clients can attach LixRay tool calls to an existing PostHog AI trace by
sending a W3C `traceparent` header. The trace ID and parent span ID are
preserved as `$ai_trace_id` and `$ai_parent_id` on LixRay telemetry.

Clients that already use PostHog identifiers may instead send
`X-PostHog-AI-Trace-ID` and `X-PostHog-AI-Parent-ID`. The optional
`X-PostHog-AI-Session-ID` groups multiple traces into one conversation or
workflow. Explicit PostHog headers take precedence over `traceparent`.
Identifiers containing unsupported characters are ignored. When no context is
provided, LixRay continues to create one fallback trace per tool call.

## Recommended workflow

1. Match the exact LixRay server name instead of searching broadly for generic
   repository or file tools.
2. If the user supplied an exact `@handle/slug` or Lix UUID, call `open_lix`
   directly. Call `list_lixes` only when the target is unknown.
3. Retain the context returned by `open_lix` from `structuredContent`
   when the host provides it. Never copy a context token from the prose
   summary. Text-only hosts receive a later `content` text block that is the
   full `structuredContent` JSON. `open_lix` reports file and directory
   counts plus a bounded `file_paths` manifest. When `file_paths_complete` is
   true, do not run another query just to list files.
4. Use `query_sql` to inspect the relevant state. When paths are known, read
   every needed file in one parameterized statement rather than listing the
   same paths first or reading files one at a time.
5. Before guessing dynamic table or column names, query `information_schema`.
6. Use `execute_sql` for any atomic SQL batch. It is always treated as
   potentially destructive. The mutation is already persisted — `rowsAffected`
   and any rows the batch itself returned are sufficient.
7. Do not follow a write with a verification `SELECT`, a second `query_sql`
   "to check", or path/length/substring readback. One `execute_sql` batch is
   the whole write (dirs + file + `ON CONFLICT` is fine inside that batch).
   No readback is needed to confirm persistence.

A successful `execute_sql` mutation is already saved. Writes persist without a
checkpoint. Use `create_checkpoint` to mark meaningful milestones so the user
can follow your work and return to important states. Create a checkpoint when
you finish a substantial, coherent piece of work, such as completing a document,
implementing a feature, or finishing a related batch of changes. Also checkpoint
when the user asks. Use judgment: routine edits, typo fixes, and intermediate
steps usually do not need checkpoints. Do not checkpoint after every edit or
ask the user to manage checkpoint timing. A checkpoint marks progress; it is not
required to save changes.

## Restore an ancestor

Call `restore` with the open Lix `context` and a `commit_id`. The commit must
exist and be an ancestor of the selected branch head. Restore moves that branch
head without creating a new commit. It does not delete the abandoned commits;
a later checkpoint-driven garbage-collection sweep may reclaim those that are
not reachable from a retention root. Other branches and branch-local untracked
rows are unchanged.

Restore is not undoable. `undo` only applies to commits made after the restore.

`create_checkpoint` returns a commit id that can be passed directly to
`restore`. There is no `restore_checkpoint` tool.

## Discover tables and columns

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

```sql
SELECT column_name, data_type, is_nullable, ordinal_position
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = $1
ORDER BY ordinal_position;
```

The stable core tables are `lix_file`, `lix_directory`, `lix_branch`, `lix_commit`, and
`lix_change`. Entity tables are repository-defined and must be discovered at
runtime.

## Files remain SQL

```sql
SELECT path, CAST(content AS TEXT) AS content
FROM lix_file
WHERE path = $1;
```

```sql
INSERT INTO lix_file (path, content)
VALUES ($1, CAST($2 AS BYTEA))
ON CONFLICT (path) DO UPDATE SET content = excluded.content;
```

Pass `$1` (path) and `$2` (file body) as `kind: "text"`. Never use
`CAST(... AS BLOB)`; if a SQL cast is needed, use `BYTEA`. Actual binaries
use `kind: "blob"` without CAST.

Lix supports Postgres `ON CONFLICT (cols) DO UPDATE` / `DO NOTHING` with
`excluded.col` on files and schema-driven views. Use it to create-or-update
without a probe `SELECT`.

```sql
INSERT INTO lix_key_value (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = excluded.value
```

Parent directories: `INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING`.

Name the conflict columns. Lix does not support `ON CONSTRAINT`, inference
without columns, or `DO UPDATE WHERE`.


## Version-control reads

Use `lix_log([anchor])` for retained commits on the branch's first-parent chain.
Filter `is_checkpoint` for milestones and order by `position`, with zero at the
anchor. For repository-global checkpoint inventory, use
`SELECT id, created_at FROM lix_commit WHERE is_checkpoint`; it includes
checkpoints outside the selected branch. Checkpoint dates use commit creation time.

```sql
SELECT lixcol_to_commit_id, lixcol_commit_created_at,
       diff_type, from_path, to_path
FROM lix_history('lix_file', $1)
WHERE id = $2 AND lixcol_commit_is_checkpoint
ORDER BY lixcol_position;
```

History reports each retained mainline commit's net changes relative to its
actual first parent, identified by `lixcol_from_commit_id` and
`lixcol_to_commit_id`. Filtering never changes that baseline. A checkpoint's
parent can be an unmarked fork or restore baseline. Drop the checkpoint predicate
to inspect retained automatic changes. Compaction can remove those revisions.
Empty commits appear in log and have no history rows; merged-side commits do not
appear separately on the first-parent timeline. Pin the same anchor when paging
log and fetching history for its commit IDs.

`lix_diff('lix_file')` compares the actual working baseline to the head;
`lix_diff('lix_file', $1, $2)` compares explicit endpoints. Working context comes
from `lix_branch.working_base_commit_id` and `commit_id`, including when the diff
is empty. The latest marked checkpoint need not be the working baseline.
Reselect through diff and guard its actual endpoint IDs for selected commands;
do not pass multi-commit history rows as command input.

```sql
SELECT path, content
FROM lix_as_of('lix_file', $1)
WHERE id = $2;
```

As-of returns complete state at one retained commit and supports loading file
bytes lazily. Relation arguments are non-null text literals; anchors and endpoints
accept parameters. `lix_change` remains repository-global retained source-record
activity, not a count of user edits or net differences. New checkpoints do not
emit synthetic marker changes; old retained records remain historical facts.
