# MCP

LixRay exposes Lix through a deliberately small MCP surface. SQL is the
universal interface for repository data; file and entity CRUD stays in SQL. `get_entity_urls` resolves browser links without changing repository data or permissions. Lix SQL is a Postgres dialect subset.

Each tool carries its own guide in its description: the file tools say how
bytes and metadata travel and how conflicts are reported; `query_sql` says
how to discover tables and columns through `information_schema` (Lix is not
SQLite; a query against `sqlite_master` gets that answer by name);
`execute_sql` says how renames and deletes look and that no readback follows
a write. That is what an agent reads before its first
query, and hosts do not reliably show the server `instructions` to the model;
the instructions repeat the workflow for hosts that do. Every other tool
description is one or two sentences. Output schemas describe the success shape
only. A failed call returns `isError` with `{ request_id, error }` in its JSON
text block and no `structuredContent`, so clients that validate structured
content against the output schema report the error instead of a schema
violation.

## Tools

- `list_lixes`, `open_lix`: find a Lix and mint its context (see below).
- `list_files`, `read_files`, `write_files`: the file path. `read_files`
  returns bytes as `{ text }` (UTF-8) or `{ base64 }`, `lixcol_metadata`,
  size, id, canonical `url`, and the `commit_id` the read reflects.
  `write_files` creates or updates files in one atomic commit, parents
  included, with content, `lixcol_metadata` (omitted keeps, an object
  replaces, `null` clears), an optional `checkpoint: true`, and
  `last_seen_commit_id`: a target file that changed since that commit refuses
  the whole write, and the error carries `current_commit_id` and the current
  contents of the conflicting files; unrelated changes never block. The
  check and the write are two steps, so a write to the same file landing
  between them is not caught; the window is milliseconds.
- `query_sql`, `execute_sql`: everything else. Files and directories are
  still tables (`lix_file`, `lix_directory`): rename, delete, and any query
  go through SQL.
- `get_entity_urls`: canonical browser links for files and directories.
- `create_checkpoint`, `restore`, `undo`, `redo`: milestones and moving the
  branch head.
- `active_branch_id`, `create_branch`, `switch_branch`, `merge_branch_preview`,
  `merge_branch`: branches. `switch_branch` returns a new context pinned to the
  branch; nothing is switched server-side.

## Context

`open_lix` returns a signed `context` that selects one Lix and one branch, and
`context_expires_at` (24 hours after opening). Pass it to every later call.
When a call answers `context_expired`, `malformed_context`, or
`invalid_context`, call `open_lix` again and take the new context from
`structuredContent`; nothing else needs redoing, because contexts carry no
state of their own.

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
   counts plus a bounded `file_paths` manifest and `files` containing `id`, `path`, and canonical `url`. Use `files[].url` exactly when linking existing files. When `file_paths_complete` is
   true, do not run another query just to list files; when it is false, the
   result carries `file_paths_sql`, the one `query_sql` statement that lists
   every path.
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
8. To link created or renamed items, call `get_entity_urls` with their UUIDs or
   absolute paths in one batch, retaining the current context. This resolves
   browser links; it is not a persistence-verification read.

A successful `execute_sql` mutation is already saved. Writes persist without a
checkpoint. Use `create_checkpoint` to mark meaningful milestones so the user
can follow your work and return to important states. Create a checkpoint when
you finish a substantial, coherent piece of work, such as completing a document,
implementing a feature, or finishing a related batch of changes. Also checkpoint
when the user asks. Use judgment: routine edits, typo fixes, and intermediate
steps usually do not need checkpoints. Do not checkpoint after every edit or
ask the user to manage checkpoint timing. A checkpoint marks progress; it is not
required to save changes.

## What a result carries

Every successful tool result has three parts, in order: a one-line summary,
zero or more `resource_link` content blocks, and the full `structuredContent`
as JSON text for hosts that only show text. The links are what a host renders
as clickable chips inside the step: `open_lix` links the repository, and an
`execute_sql` batch links each file or directory it wrote or updated, with
the same canonical URL `get_entity_urls` would return. Other tools carry no
links, and a failed call has the summary and the JSON text only. The summary names the
action ("Wrote sales/lead-research.md · Updated leads.csv · 7 rows
affected"), so an agent's narration is not the only trace of what happened.

This comes from Lix, not from parsing SQL. Every `execute_sql` call stamps
its changes with an `origin_key` of `mcp:<request_id>` (a caller-supplied
`origin_key` becomes its prefix), and the server then asks `lix_change`
what carries that key. A file with a descriptor change was written or
renamed, one with only content or entity changes was updated, a null
descriptor snapshot was deleted; directories likewise. Renames, writes by
id, and cascades all show up because Lix recorded them. Reads link
nothing; deletions are named in the summary but not linked.

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

## Canonical browser URLs

A browser URL is `/file/<id>/<path>` for a file and `/folder/<id>/<path>` for a
folder: the entity's UUID encoded as unpadded Base64url, then the entity's own
path so the link reads as what it opens. The id is what resolves — the app
rewrites the path from it, so a link that names no path, or a path the entity
has since outgrown, still opens the right item and corrects itself. Folders
carried `/dir/` before; those links redirect. Clients should copy the
server-generated `url` from `open_lix.files` or `get_entity_urls` exactly as
returned rather than building one from `file_paths`, which are SQL paths. A URL carries a
`branch` parameter only when its branch is not the Lix's default branch, the
same rule the app applies to its own links.
Do not manually encode IDs or guess URLs. The server uses the same URL builder
as app navigation and sharing.

For example, after writing `/gtm/social/posts.csv`, call:

```json
{
  "context": "<context returned by open_lix>",
  "entities": [
    { "kind": "file", "path": "/gtm/social/posts.csv" },
    { "kind": "directory", "path": "/gtm/social" }
  ]
}
```

`get_entity_urls` returns `entities` with `kind`, `id`, `path`, and `url` in the
requested order. Each selector requires exactly one UUID `id` or absolute
`path`; batches contain 1–50 selectors. UUID selectors follow renames and moves.
A root-directory selector (`kind: directory`, `path: /`) returns the repository
URL with `id: null`. Missing items return a tool error, never a fabricated link.
If resolution fails, report it and omit the item link rather than guessing.

These are navigation links, not capabilities: they do not publish private data
or grant access. Resolution uses the signed context's repository and branch,
and current namespace/repository names. Link resolution remains a separate
read-only operation so a failure cannot misreport a successful write as failed.
