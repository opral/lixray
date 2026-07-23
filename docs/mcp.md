# MCP

LixRay exposes workspace discovery, branch control, and raw Lix SQL over
[Streamable HTTP MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http).
The production endpoint is:

```text
https://lixray.com/mcp
```

MCP authorization is separate from a LixRay browser session. Clients discover
the OAuth configuration through `/.well-known/oauth-protected-resource`.

For example, connect Codex with:

```sh
codex mcp add LixRay \
  --url https://lixray.com/mcp \
  --oauth-resource https://lixray.com
codex mcp login LixRay
```

## Tools

The server exposes exactly four tools:

| Tool               | Input                                     | Result                             |
| ------------------ | ----------------------------------------- | ---------------------------------- |
| `list_workspaces`  | `{}`                                      | `{"workspaces":[...]}`             |
| `active_branch_id` | `{"workspace_ref":"..."}`                 | `{"branch_id":"..."}`              |
| `switch_branch`    | `workspace_ref`, `branch_id`              | `{"branch_id":"..."}`              |
| `execute`          | `workspace_ref`, 1–100 ordered statements | `{"results":[...]}` in batch order |

Use the exact workspace UUID, slug, or `@namespace/slug` as `workspace_ref`.
Prefer the UUID returned by `list_workspaces` when it is available; do not
guess workspace or branch IDs.

`switch_branch` changes shared workspace state. Active Lix tables and
subsequent SQL calls use that branch. Call `active_branch_id` to inspect the
current branch, query `lix_branch` with `execute` to discover branches, and use
`_by_branch` tables when a query must span branches without switching.

## Execute SQL

`execute` uses **Apache DataFusion SQL**, not SQLite. In particular, DDL and
recursive CTEs are unsupported. Statements may use `$1`, `$2`, … or `?`
parameters. All statements in a call run atomically and in order: if one
fails, the whole batch rolls back.

This request reads a UTF-8 file and updates another file in one batch:

```json
{
  "workspace_ref": "@acme/launch-q3",
  "statements": [
    {
      "sql": "SELECT path, CAST(data AS TEXT) AS text FROM lix_file WHERE path = $1",
      "params": ["/README.md"]
    },
    {
      "sql": "UPDATE lix_file SET data = $1 WHERE path = $2",
      "params": [{ "kind": "blob", "base64": "IyBVcGRhdGVkCg==" }, "/notes/status.md"]
    }
  ]
}
```

The result array follows statement order. Each row is positional: its values
correspond by index to `columns`.

```json
{
  "results": [
    {
      "columns": ["path", "text"],
      "rows": [["/README.md", "# Launch plan\n"]],
      "rowsAffected": 0,
      "notices": []
    },
    {
      "columns": [],
      "rows": [],
      "rowsAffected": 1,
      "notices": []
    }
  ]
}
```

Do not interpret a row as an object or rely on duplicate column names being
made unique. Alias expressions where necessary and map
`columns[index]` to `rows[row][index]`.

### Values

Use native JSON values for ordinary SQL values:

| SQL value | MCP parameter/result cell        |
| --------- | -------------------------------- |
| `NULL`    | `null`                           |
| Boolean   | `true` or `false`                |
| Numeric   | JSON number                      |
| Text      | JSON string                      |
| BLOB      | `{"kind":"blob","base64":"..."}` |
| SQL JSON  | `{"kind":"json","value":...}`    |

Native numeric parameters must be finite and between
`-9007199254740991` and `9007199254740991`. A native safe integral value binds
as SQL integer; a native nonintegral value binds as SQL REAL. When an integral
value must remain REAL, or a finite REAL exceeds that native range, use the
narrow input-only escape `{"kind":"float","value":1}`. Numeric result cells
remain native JSON numbers.

The BLOB payload must use canonical RFC 4648 standard base64, including padding
when required. The SQL JSON wrapper is required even when its `value` is itself
a JSON scalar.

For example, a parameter list containing a Boolean and SQL JSON is:

```json
{
  "params": [
    true,
    {
      "kind": "json",
      "value": { "owner": "agent", "labels": ["ready"] }
    }
  ]
}
```

## Migrating from tagged scalars

The primitive scalar contract is a hard cut. There is no version negotiation
or compatibility mode. Clients that previously wrapped every parameter and
result cell must remove the wrappers for `NULL`, Boolean, integer, text, and
ordinary nonintegral REAL values:

```json
{
  "before": [
    { "kind": "null", "value": null },
    { "kind": "bool", "value": true },
    { "kind": "int", "value": 20 },
    { "kind": "float", "value": 1.5 },
    { "kind": "text", "value": "/README.md" }
  ],
  "after": [null, true, 20, 1.5, "/README.md"]
}
```

Keep the float wrapper only when its type information cannot survive as a
native JSON number. For example, `{"kind":"float","value":1}` must remain
wrapped to avoid binding as SQL integer. The legacy `null`, `bool`, `int`, and
`text` wrappers are always rejected.

Make the equivalent primitive change when decoding result rows. BLOB and SQL
JSON wrappers are unchanged; float result wrappers become native numbers.
Result envelopes also remain unchanged: `results[].columns`, `rows`,
`rowsAffected`, and `notices`.

## Lix SQL essentials

The stable core tables are:

- `lix_file` — active files; `data` is a BLOB.
- `lix_directory` — active directories.
- `lix_branch` — branch catalog.
- `lix_change` — global activity.

Files, directories, and registered entity tables have `_by_branch` companions
with `lixcol_branch_id`, plus read-only `_history` companions. Branch and
change tables do not.

Workspace-specific application schemas are registered dynamically. Discover
them only when needed:

```sql
SELECT lix_json_get_text(value, 'x-lix-key') AS table_name, value AS json_schema
FROM lix_registered_schema
WHERE NOT starts_with(lix_json_get_text(value, 'x-lix-key'), 'lix_')
ORDER BY table_name
```

Cast `lix_file.data AS TEXT` only when the file is known to contain UTF-8.
File paths never end in `/`; directory paths always do.

Typed `_history` queries require
`lixcol_start_commit_id = lix_active_branch_commit_id()`. For complete history
of one entity, also filter its user primary-key columns. Resolve keys from
active rows when possible; for a deleted or renamed file, first use a bounded
old-path lookup in `lix_file_history`, then query its full history by `id`. Use
`lixcol_commit_created_at` for chronology and `lixcol_depth` for graph distance;
there is no `lixcol_commit_id` column.
