# MCP

LixRay exposes Lix through a deliberately small MCP surface. SQL is the
universal interface for repository data; there are no separate file or entity
tools.

## Recommended workflow

1. Call `list_lixes` when the target repository is unknown.
2. Call `open_lix` and retain its returned context.
3. Use `execute` to inspect the relevant state.
4. Before guessing dynamic table or column names, query `information_schema`.
5. Use `execute_batch` for related mutations and finish the batch with a
   focused verification `SELECT`.
6. Report `rowsAffected` and the returned verification rows.

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
VALUES ($1, CAST($2 AS BYTEA));
```

For a multi-file setup, send the inserts as one `execute_batch` request and
make its final statement a readback query:

```sql
SELECT path
FROM lix_file
WHERE path IN ($1, $2, $3)
ORDER BY path;
```

`lix_file.content` is binary. MCP callers pass it as a wire value with
`{"kind":"blob","base64":"..."}`.
