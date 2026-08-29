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

1. Call `list_lixes` when the target repository is unknown. The text channel
   lists each lix as `@handle/slug` plus uuid.
2. Call `open_lix` and retain its returned context from `structuredContent`
   when the host provides it. Never copy a context token from the prose
   summary. Text-only hosts receive a later `content` text block that is the
   full `structuredContent` JSON. `open_lix` reports file and directory
   counts so empty lixes are obvious.
3. Use `query_sql` to inspect the relevant state when you need to read.
4. Before guessing dynamic table or column names, query `information_schema`.
5. Use `execute_sql` for any atomic SQL batch. It is always treated as
   potentially destructive. The mutation is already persisted — `rowsAffected`
   and any rows the batch itself returned are sufficient.
6. Do not follow a write with a verification `SELECT`, a second `query_sql`
   "to check", or path/length/substring readback. One `execute_sql` batch is
   the whole write (dirs + file + `ON CONFLICT` is fine inside that batch).
   Then stop.

A successful `execute_sql` mutation is already saved. Writes persist without a
checkpoint. `create_checkpoint` is an explicit user-facing action, not agent
ceremony — not a Git-style commit, and not required for durability. Do not call
`create_checkpoint` after a write, after every change, or "to be safe." The
agent may recommend that the user checkpoint when a task or session is done;
prefer leaving the checkpoint to the user.

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

The stable core tables are `lix_file`, `lix_directory`, `lix_branch`, and
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
