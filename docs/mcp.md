# MCP

LixRay runs a remote MCP server at `https://lixray.com/mcp`. Any MCP client can
connect: Claude, ChatGPT, Gemini, Codex, or your own agent. Agents read and
write files and tables with SQL, work on branches, and undo or restore changes.

## Connect a client

Add `https://lixray.com/mcp` as a remote MCP server in your client and sign in
with your LixRay account. Menus differ by client.

Codex:

```sh
codex mcp add LixRay --url https://lixray.com/mcp --oauth-resource https://lixray.com
codex mcp login LixRay
```

How it works:

- The server is stateless (MCP protocol `2026-07-28`): each request stands
  alone. There is no session and no `initialize` call.
- Sign-in uses OAuth 2.1 with PKCE and dynamic client registration. Scopes:
  `openid email profile offline_access`.
- [Access tokens](./access-tokens.md) (`lixray_pat_...`) are for the SDK and
  HTTP API. They do not work on `/mcp`.

## Reference for agent authors

Agents use two tools for data: `query_sql` to read and `execute_sql` to write.
The rest of this page describes how they behave in detail.

## Direct SQL calls

For SQL when the repository is known, call `query_sql` or `execute_sql` with `lix_ref` (an exact `@handle/slug` or UUID) and optional `branch_id`. Opening first is unnecessary. The omitted branch is the repository default branch, independent of any browser or previous call's active branch. Alternatively, pass an existing `context` alone to retain its selected branch. `open_lix` remains available for its bounded path manifest and for obtaining contexts used by branch and URL tools.

Example: `execute_sql({ lix_ref: "@acme/company", statements: [{ sql: "UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE path = $2", params: [{ kind: "text", value: "hello" }, { kind: "text", value: "/notes.txt" }] }] })`.

DataFusion scalar expressions such as `REPLACE`, `CONCAT`, and `||` work inside a `BYTEA` cast for file updates. Use one statement per batch entry and explicit `ON CONFLICT (path)` targets. `query_sql` is the sole read path for repository data and files; `execute_sql` is the one write path.

Execution errors return `isError: true` and a JSON text block, without success-schema `structuredContent`. Errors include the code, message, hint and details, plus zero-based `statement_index` when known. Two Lix errors are restated in the caller's terms: a move or write onto a path that is taken names that destination path (Lix names the parent directory by id) with the hint "The destination exists; pick another path or delete it first in the same batch.", and text bound straight into `lix_file.content` gets "Bind text as CAST($n AS BYTEA) with a text param." Write `outcome` is `not_committed` for known rejections, `unknown` for ambiguous transport/internal failures, and `committed` for response failures after confirmed completion. Correct rejected statements before retrying. Inspect affected state for unknown outcomes; never blindly replay a batch. Verify successful writes when the user requested validation, rather than routinely reading every write back.

LixRay exposes Lix through a deliberately small MCP surface. SQL is the
universal interface for repository data, including file reads and file/entity
CRUD. `get_entity_urls` resolves browser links without changing repository
data or permissions. Lix SQL is a Postgres dialect subset.

Each SQL tool carries its guide in its description: `query_sql` says how to
read bounded file content and discover tables and columns through
`information_schema` (Lix is not
SQLite; a query against `sqlite_master` gets that answer by name);
`execute_sql` says how every write looks — upserts, moves, deletes, the guard
and the checkpoint — and how to recover from failed writes. That is what an agent reads before its first
query, and hosts do not reliably show the server `instructions` to the model;
the instructions repeat the workflow for hosts that do. Every other tool
description is one or two sentences. Output schemas describe the success shape
only. A failed call returns `isError` with `{ error }` in its JSON
text block and no `structuredContent`, so clients that validate structured
content against the output schema report the error instead of a schema
violation.

## Data boundaries

Use only explicit snippets and repository content needed for the current task.
Do not import chat history or remembered personal profiles. Do not send health
information, biometric data, government identifiers, payment card data, passwords,
API keys, or other authentication secrets. Ask for a non-sensitive or redacted
version when needed. The same guidance appears on every tool card.

Discovery returns repository identifiers and namespace handles, without namespace
UUIDs or profile names. Contexts use authenticated AES-GCM encryption, retain user
and OAuth client binding and expiry, and never grant access without authentication.
Old signed contexts must be reopened with `open_lix` after deployment.
Request IDs remain in HTTP `X-Request-ID` headers and server telemetry, not tool
results or error messages. Context errors provide a reopen instruction without
diagnostic timestamps or identifiers.

## Tools

- `list_lixes`, `open_lix`: find a Lix and mint its context (see below).
- `query_sql`: the read path for repository data and files. Paths, metadata,
  sizes, and content are selected with SQL. Use
  [bounded file reads](#bounded-file-reads) for content.
- `execute_sql`: the write path. Files and directories are tables (`lix_file`,
  `lix_directory`); see [Writing files](#writing-files).
- `get_entity_urls`: stable document links and readable display links for files and directories.
- `diff`: list the files that differ between two points (a checkpoint, a
  commit, a branch, `working`, or `latest_checkpoint`).
- `create_checkpoint`, `restore`, `undo`, `redo`: mark milestones, copy an old
  state into a new commit, and undo or redo.
- `active_branch_id`, `create_branch`, `switch_branch`, `merge_branch_preview`,
  `merge_branch`: branches. `create_branch` takes `name`, an optional `id`, and
  an optional `from_commit_id`. `switch_branch` returns a new context pinned to
  the branch; pass it to later calls.

## Context

`open_lix` returns an encrypted `context` that selects one Lix and one branch, and
`context_expires_at` (24 hours after opening). Without `branch_id`, `open_lix` uses the Lix's active branch. SQL calls can instead use `lix_ref` directly; without `branch_id` they use the default branch. Other repository tools accept this context, including contexts returned by SQL calls.
When a call answers `context_expired`, `malformed_context`, or
`invalid_context`, call `open_lix` again and take the new context from
`structuredContent`; nothing else needs redoing, because contexts carry no
state of their own.

## Bounded file reads

Agents previously overfetched file data through `read_files`: its SQL selected
the full `content` blob, then the service applied the 1 MiB text cutoff after
the bytes had already been fetched. This caused [#485](https://github.com/opral/lixray/issues/485): large-file hydration could exceed the transport response budget before the agent received the promised `too-large` metadata. An agent asking only for a size or excerpt still fetched the full file.

Use `OCTET_LENGTH(content)` to measure a file, then
`SUBSTRING(content FROM 1 FOR 4096)` to fetch only an initial byte range:

```sql
SELECT path, OCTET_LENGTH(content) AS size
FROM lix_file
WHERE path = $1;

SELECT SUBSTRING(content FROM 1 FOR 4096) AS excerpt_bytes
FROM lix_file
WHERE path = $1;
```

The Lix engine pushes these expressions down to blob metadata and range reads,
so size checks and excerpts do not materialize full content. Only select
`CAST(content AS TEXT)` without `SUBSTRING` when the file is known to be small
and its full content is needed.

## End-to-end trace correlation

MCP clients can attach LixRay calls to an existing OpenTelemetry trace by
sending valid W3C `traceparent` and optional `tracestate` headers. LixRay
creates an HTTP server span with that remote parent, one child span per tool,
and propagates context to the Lix reference server. Without a valid parent,
the HTTP request starts a new trace.

Official MCP analytics expose `trace_id` and `span_id` for correlation with
native tracing. PostHog-specific trace and parent headers are not supported.
See [MCP telemetry](./mcp-telemetry.md) for span lifetimes and privacy rules.

## Recommended workflow

1. Match the exact LixRay server name instead of searching broadly for generic
   repository or file tools.
2. For SQL with an exact `@handle/slug` or Lix UUID, pass lix_ref directly to query_sql or execute_sql. Call `list_lixes` only when the target is unknown.
3. Use open_lix when inventory is useful. Retain the context returned by SQL or open_lix from `structuredContent`
   when the host provides it. Never copy a context token from the prose
   summary. Text-only hosts receive a later `content` text block that is the
   full `structuredContent` JSON. `open_lix` reports file and directory
   counts plus a bounded `file_paths` manifest and `files` containing `id`, `path`, stable `url`, and readable `display_url`. Use `files[].url` exactly in documents and machine-readable content. When `file_paths_complete` is
   true, do not run another query just to list files; when it is false, the
   result carries `file_paths_sql`, the one `query_sql` statement that lists
   every path.
4. Read files with `query_sql`: select only needed metadata and use
   `OCTET_LENGTH(content)` for size or bounded `SUBSTRING` for excerpts.
   Avoid full-content projections unless the file is known to be small and its
   full content is needed.
5. Before guessing dynamic table or column names, query `information_schema`.
6. Write with `execute_sql`, one call per coherent change: its creates,
   updates, moves, renames, copies, deletes and directory changes in one
   ordered atomic batch, guarded by `last_seen_commit_id` and marked by
   `checkpoint: true` when it is a milestone. It is always treated as
   potentially destructive. The mutation is already persisted — `rowsAffected`
   and any rows the batch itself returned are sufficient.
7. Successful batches are persisted. Read back when the outcome is unknown or
   validation is part of the task; never blindly replay an uncertain write.
8. To link created or renamed items, call `get_entity_urls` with their UUIDs or
   absolute paths in one batch, retaining the current context. This resolves
   browser links; it is not a persistence-verification read.

A successful `execute_sql` mutation is already saved. Writes persist without a
checkpoint. Use `checkpoint: true` on the batch, or `create_checkpoint`, to
mark meaningful milestones so the user
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
the same readable `display_url` that `get_entity_urls` would return. Use
`get_entity_urls` when SQL results need browser links. A failed call has the
summary and the JSON text only. The summary names the
action ("Wrote sales/lead-research.md · Updated leads.csv · 7 rows
affected"), so an agent's narration is not the only trace of what happened.

`execute_sql` and `diff` advertise
`_meta.ui.resourceUri: "ui://lixray/diff-card/v1"`. MCP Apps hosts fetch that
static HTML resource using `resources/read`; it is available before the call
and across stateless requests, without repository data in its URL or template.
The view initializes through `ui/initialize`, then receives the result through
`ui/notifications/tool-result`.

Per-call cards travel in result `_meta["lixray/diff-card"]`, outside both
`content` and `structuredContent`: the bar's words (`title`, `folder`, `tally`,
`repository`) and one entry per file (`path`, `name`, `status`, `label`, `url`,
an inline `icon`, and Atelier's `html` view or a `note` saying why there is
none). No embedded HTML resource appears in content. Standard clients still
receive the text summary, file links, and saved receipt even when they do not
support MCP Apps. A card is optional; agents must not claim the user saw one
merely because the call succeeded.

The card is collapsed by default: one 44px bar with the files' type icons,
what happened ("1 file added", "3 files modified"; "N files written", or
"changed" for `diff`, when a set did several things at once), the deepest
common folder, and — only for such a mixed set — "2 added · 1 modified"
counts,
so a long chat reads as a list of writes and none of them says a thing
twice. Opened,
the bar becomes the header and below it sits Atelier's static render of one
file's change in a scrolling panel, with a dark pill to page through the
files (each with its diff glyph and counts) and an "Open in LixRay" button
that goes through the host's `ui/open-link`. Open, every card is the same
height whatever the file is — a long document scrolls inside the panel — so
opening one moves the chat by a known amount and no card leaves a strip of
empty frame below it. The view reports that height on every toggle, and sets
it on its own document for hosts that measure the frame instead. The card's
chrome — head, foot, the ground they sit on — takes its colour scheme from
the chat around it, so a closed card reads as one more line of that chat.
The rendered file does not: it is a document in Atelier, and Atelier is
light. The foot carries a toggle for a reader who wants that file dark.
Markdown
and CSV previews use Atelier's static renderer; they carry no scripts, and the view mounts them in a shadow root. A document's pictures are
drawn from the addresses it names, so a host that refuses them shows their
alt text; the resource itself invokes no tools and asks for nothing else.

A card lists up to 50 files and carries previews for the first six; the rest
are paged with a note. The call itself carries no bytes of the change: it
returns the commit span it moved between, and the card comes from asking Lix
what changed between those two commits — `lix_diff('lix_file', before,
after)` with `from_content` and `to_content`. That is the same question a
checkpoint, or any two commits, would be asked, so one render path serves an
SQL batch (the files its change log says it touched) and `diff`;
and because the answer is keyed to the commits rather than to a moment in
time, nothing another writer does afterwards changes what the card describes.
Each preview is trimmed to what changed, with a note of what was skipped; a
change too large for a thread keeps its page and sends the reader to the file.

`diff` compares two points of the Lix in context: `before` and `after` are each
`{ checkpoint_id }`, `{ commit_id }`, `{ branch_id }`, `"working"` (the branch
as it stands), or `"latest_checkpoint"` (the nearest checkpoint behind it),
with optional `paths` to narrow. It returns `files` (`path`, `status` of
added/modified/removed/moved, `before_path` for a move, the two commit ids,
stable `url` and readable `display_url`), the resolved `before` and `after`, `commit_id` (the after end), the
repository `url`, a one-line summary ("3 files changed between latest
checkpoint … and working: …"), file links, and the same card. A ref that names
nothing is refused with a hint before Lix is asked to compare. Removed files
have no current entity to open, so both URL fields point to the repository.

SQL execution preserves Lix's receipt: `query_sql.result.commit` is null for a
read; `execute_sql` has one top-level `commit: { before, after } | null` for the
batch. Its per-statement results contain rows, counts and notices, without
repeating the receipt; `commit.after` is the commit to pass as the next
batch's `last_seen_commit_id`. With `checkpoint: true` the result also carries
`checkpoint_commit_id`. If completion reporting or the checkpoint fails after
the batch committed, the result is still a success and carries a `warning`
("Saved; checkpoint unavailable. Do not repeat the batch."); do not repeat it.


The full SQL reference is also available via `resources/read` at
`lixray://docs/sql`. Server instructions give routing and recovery rules; SQL
tool descriptions retain the essentials needed to make a first query.

When asked to undo the last change, prefer the `undo` tool over manual SQL
reversal when that change is still the latest undoable action. The tool executes
`SELECT commit_id FROM lix_undo()` on the context branch and returns its one-row
receipt; inspect history if later edits may exist. `redo` uses
`SELECT commit_id FROM lix_redo()`. Both return `commit_id: null` when there is
nothing to apply and stop at checkpoints.
`restore(commit_id)` creates a new commit with the old state.
Targeted reversal needs an engine-supported atomic target check; a separate
read followed by undo cannot protect against a concurrent writer.

This comes from Lix, not from parsing SQL. Every `execute_sql` call stamps
its changes with an `origin_key` of `mcp:<request_id>` (a caller-supplied
`origin_key` becomes its prefix), and the server then asks `lix_change`
what carries that key. A file with a descriptor change was written or
renamed, one with only content or entity changes was updated, a null
descriptor snapshot was deleted; directories likewise. Renames, writes by
id, and cascades all show up because Lix recorded them. Reads link
nothing; deletions are named in the summary but not linked.

## Restore a commit

Call `restore` with the open Lix `context` and a `commit_id`. It copies the
content of that commit into a new commit on the context branch. History is
kept, and `undo` can reverse the restore. It returns the new `commit_id`, or
`null` if nothing changed.

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

## Writing files

`execute_sql` is the one write path. One call carries one coherent change —
its creates, updates, moves, renames, copies, deletes and directory changes —
as an ordered batch that commits or rolls back as a whole.

- Create or update: `INSERT INTO lix_file (path, content) VALUES ($1,
  CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content =
  excluded.content`. Missing parent directories are created. Per-file JSON
  metadata is the `lixcol_metadata` column, bound as `kind: "json"`.
- Move or rename: `UPDATE lix_file SET path = $1 WHERE path = $2`. The file
  keeps its id, so links to it survive, and missing parents are created. A
  destination that already exists fails the whole batch. Copy plus delete
  makes a new id and breaks links; do not move that way.
- Delete: `DELETE FROM lix_file WHERE path = $1`. Directories work the same
  on `lix_directory`; moving a directory moves its files, ids kept. Paths
  have no trailing slash.
- `checkpoint: true` marks the batch's result as a checkpoint and returns
  `checkpoint_commit_id`.
- `last_seen_commit_id` (the `commit_id` of `open_lix`, or `commit.after`
  of an earlier batch) guards the batch. It runs in one transaction that
  finds the files and directories that changed between that commit and the
  head, runs the statements, and compares each of those entities as the
  batch left it — path, content and metadata, or its absence — with the
  head. Any difference refuses the whole batch with a `conflict` error:
  `details.current_commit_id` and, for each conflicting file, its current
  `path`, `content` (or `encoding`) and `lixcol_metadata`. Merge and run the
  batch again with `last_seen_commit_id = details.current_commit_id`.
  Changes the batch does not touch never block, and a concurrent commit
  replays the transaction, guard included.

A consolidation — update the plan, move two drafts into `archive/` (their
ids and links survive), leave a redirect where one was, and checkpoint:

```json
{
  "lix_ref": "@acme/company",
  "last_seen_commit_id": "<commit_id from open_lix>",
  "checkpoint": true,
  "statements": [
    {
      "sql": "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content",
      "params": [
        { "kind": "text", "value": "/gtm/plan.md" },
        { "kind": "text", "value": "# Plan\n\nMerged from a.md and b.md.\n" }
      ]
    },
    {
      "sql": "UPDATE lix_file SET path = $1 WHERE path = $2",
      "params": [
        { "kind": "text", "value": "/gtm/archive/a.md" },
        { "kind": "text", "value": "/gtm/a.md" }
      ]
    },
    {
      "sql": "UPDATE lix_file SET path = $1 WHERE path = $2",
      "params": [
        { "kind": "text", "value": "/gtm/archive/b.md" },
        { "kind": "text", "value": "/gtm/b.md" }
      ]
    },
    {
      "sql": "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA))",
      "params": [
        { "kind": "text", "value": "/gtm/a.md" },
        { "kind": "text", "value": "Moved to [plan.md](plan.md).\n" }
      ]
    }
  ]
}
```

Reading stays SQL too:

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
anchor. The flag is active at the selected anchor, so this is the eligible
checkpoint timeline for that branch. `lix_commit` contains only retained commit
identity and creation time; it has no checkpoint flag. Checkpoint dates use
commit creation time.

```sql
SELECT log.commit_id, history.lixcol_commit_created_at,
       history.diff_type, history.from_path, history.to_path
FROM lix_log($1) AS log
JOIN lix_history('lix_file', $1) AS history
  ON history.lixcol_to_commit_id = log.commit_id
WHERE history.id = $2 AND log.is_checkpoint
ORDER BY log.position;
```

History reports each retained mainline commit's net changes relative to its
actual first parent, identified by `lixcol_from_commit_id` and
`lixcol_to_commit_id`. The history function has no checkpoint marker column;
join it to `lix_log` on the destination commit ID and filter the log's active
`is_checkpoint` flag. Filtering the joined result never changes that baseline.
A checkpoint's parent can be an unmarked fork or restore baseline. Drop the
checkpoint predicate to inspect retained automatic changes. Compaction can
remove those revisions. Empty commits appear in log and have no history rows;
merged-side commits do not appear separately on the first-parent timeline. Pin
the same anchor when paging log and fetching history for its commit IDs.

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

Each entity has two browser URLs. The stable `url` is `/file/<id>` for a file or
`/folder/<id>` for a folder. The readable `display_url` adds the current path
as a slug, such as `/file/<id>/gtm/gtm-playbook.md`. The id is the entity's UUID
encoded as unpadded Base64url and is the only part used to resolve the entity.
The app expands a short link or refreshes a stale slug to the current readable
path in the browser. Store `url` in Markdown and other machine-readable content;
use `display_url` for human-facing links. Copy these values exactly as returned
rather than building one from `file_paths`, which are SQL paths. A URL carries a
`branch` parameter only when its branch is not the Lix's default branch, the
same rule the app applies to its own links. A URL without `branch` follows the
repository's current default branch; a URL with `branch` stays pinned to that
branch ID.
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

`get_entity_urls` returns `entities` with `kind`, `id`, `path`, `url`, and `display_url` in the
requested order. Each selector requires exactly one UUID `id` or absolute
`path`; batches contain 1–50 selectors. UUID selectors follow renames and moves.
A root-directory selector (`kind: directory`, `path: /`) returns the repository
URL with `id: null`. Missing items return a tool error, never a fabricated link.
If resolution fails, report it and omit the item link rather than guessing.

These are navigation links, not capabilities: they do not publish private data
or grant access. Resolution uses the encrypted context's repository and branch,
and current namespace/repository names. Link resolution remains a separate
read-only operation so a failure cannot misreport a successful write as failed.

### Restore selected historical rows

To restore one deleted file without changing unrelated later work, use
`execute_sql` with this statement and two `kind: "text"` parameters: the source
commit ID and the file ID.

```sql
SELECT commit_id FROM lix_restore(
  $1,
  ARRAY[lix_row_ref('lix_file', NULL, $2)]
);
```

This creates a commit on the current context branch, preserves the selected
file's ID and historical bytes, and returns a commit receipt. It also supports
restoring selected ordinary rows. `lix_history` and `lix_diff` return opaque
`kind: "row_ref"` values with canonical `lix_row_ref:v2:` strings; pass these
back as `kind: "row_ref"` parameters rather than interpreting their contents.

Query-based `INSERT` into `lix_file.content` is unsupported. Adding a BYTEA cast
does not enable that route. For new file bytes use `INSERT ... VALUES` with bound
binary content; for historical recovery use `lix_restore` as above.

Scoped SQL restoration differs from the `restore` tool, which moves the branch
head, and from `undo`/`redo`, which reverse or replay the undoable action. Scoped
restoration applies historical state to the selected rows; it is not a
conditional reversal protecting against concurrent writers. Check for later
changes and use a guarded write when reversal must preserve concurrent changes.
The retired `lix_revert` SQL write sink is read-only and must not be used.
