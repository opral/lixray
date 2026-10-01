# Build an internal app

Lix repositories have a SQL interface and JavaScript bindings. Your company can
build internal apps on top of its repository, with application data and files
in the same versioned store.

This example works with files and a custom task table in a shared repository.
Lix tracks changes to both automatically.

## Install

```bash
npm install @lix-js/sdk@0.16.0
```

## Connect to your repository

[Create an access token](./access-tokens.md), then set `LIXRAY_REPOSITORY_URL`
and `LIXRAY_ACCESS_TOKEN` in your Node.js environment. Open the hosted repository:

```javascript
import { openLix } from "@lix-js/sdk";

const lix = await openLix({
  server: {
    url: process.env.LIXRAY_REPOSITORY_URL,
    headers: {
      Authorization: `Bearer ${process.env.LIXRAY_ACCESS_TOKEN}`,
    },
  },
});
```

`LIXRAY_REPOSITORY_URL` is the SDK endpoint for your repository:
`https://lixray.com/lix/REPOSITORY_ID`. Use the repository ID, not its name or
browser page URL. Keep the token in your server environment, outside browser code.

## Work with files

Continue in the same script:

```javascript
const path = `/tasks/${crypto.randomUUID()}.txt`;
const encode = (text) => new TextEncoder().encode(text);

// Add a task to the shared repository.
await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
  path,
  encode("TODO: Review the launch plan"),
]);

// Read it back.
const result = await lix.execute(
  "SELECT content FROM lix_file WHERE path = $1",
  [path],
);
console.log(new TextDecoder().decode(result.rows[0].content));

// Mark it complete. Lix records the change automatically.
await lix.execute("UPDATE lix_file SET content = $1 WHERE path = $2", [
  encode("DONE: Review the launch plan"),
  path,
]);
```

The script prints `TODO: Review the launch plan`. The task file then contains
`DONE: Review the launch plan` in the shared repository, with both writes in
its history. The `$1` and `$2` placeholders pass values separately from SQL.

## Register a custom table

For structured application data, register a schema once when setting up your
repository. This defines an `acme_task` table with an ID, title, and completion
status:

```javascript
const schema = {
  $schema: "https://lix.dev/schema-v1.json",
  key: "acme_task",
  columns: [
    { name: "id", type: "uuid", nullable: false },
    { name: "title", type: "text", nullable: false },
    { name: "done", type: "boolean", nullable: false },
  ],
  primary_key: ["id"],
};

await lix.execute(
  "INSERT INTO lix_registered_schema (schema_key, value) VALUES ($1, $2::jsonb)",
  [schema.key, JSON.stringify(schema)],
);
```

## Use your custom table

Query the registered table with the same SQL interface you used for files:

```javascript
const taskId = crypto.randomUUID();

await lix.execute(
  "INSERT INTO acme_task (id, title, done) VALUES ($1, $2, $3)",
  [taskId, "Review the launch plan", false],
);

await lix.execute("UPDATE acme_task SET done = $1 WHERE id = $2", [
  true,
  taskId,
]);

const tasks = await lix.execute("SELECT id, title, done FROM acme_task");
console.table(tasks.rows);
```

Files and custom rows live in the same repository and share its version history.
When your script is finished, close the connection:

```javascript
await lix.close();
```

See [schemas](https://lix.dev/docs/schemas) for more column types and
[live queries](https://lix.dev/docs/collaboration-and-sync) to react to changes
from teammates and agents.
