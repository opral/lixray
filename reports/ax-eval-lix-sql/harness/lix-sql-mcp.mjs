#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { descriptionRounds } from "./tasks.mjs";
import {
  CANONICAL_BASE64_PATTERN,
  decodeWireParam,
} from "./wire-values.mjs";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = {
  id: WORKSPACE_ID,
  name: "AX evaluation workspace",
  slug: "ax-eval",
  organization: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Acme",
    handle: "acme",
  },
};

const round = process.argv[2] ?? "current-compact";
const roundConfig = descriptionRounds.find(
  (candidate) => candidate.id === round,
);
if (!roundConfig) {
  throw new Error(`Unknown description round: ${round}`);
}
const fixtureProfile = process.argv[3] ?? "default";
if (!["default", "holdout"].includes(fixtureProfile)) {
  throw new Error(`Unknown fixture profile: ${fixtureProfile}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const workspaceRequire = createRequire(
  resolve(repoRoot, "web-app/package.json"),
);
const importWorkspacePackage = async (specifier) =>
  import(pathToFileURL(workspaceRequire.resolve(specifier)).href);
const sdkEntry = process.env.AX_EVAL_LIX_SDK_ENTRY
  ? resolve(process.env.AX_EVAL_LIX_SDK_ENTRY)
  : workspaceRequire.resolve("@lix-js/sdk");
const { Value, openLix } = await import(pathToFileURL(sdkEntry).href);
const { Server } = await importWorkspacePackage(
  "@modelcontextprotocol/sdk/server/index.js",
);
const { StdioServerTransport } = await importWorkspacePackage(
  "@modelcontextprotocol/sdk/server/stdio.js",
);
const { CallToolRequestSchema, ListToolsRequestSchema } =
  await importWorkspacePackage("@modelcontextprotocol/sdk/types.js");

function executeDescription(config) {
  if (config.descriptionSnapshot) {
    return readFileSync(
      resolve(reportRoot, config.descriptionSnapshot),
      "utf8",
    );
  }
  const revision = config.revision;
  if (!revision) {
    throw new Error(`Round ${config.id} has no description source.`);
  }
  const generated = execFileSync(
    "git",
    ["show", `${revision}:web-app/mcp-tools.json`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const descriptor = JSON.parse(generated).find(
    (tool) => tool.name === "execute",
  );
  if (!descriptor) throw new Error(`No execute tool at ${revision}`);
  return descriptor.description;
}

const blobWireValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "blob" },
    base64: {
      type: "string",
      contentEncoding: "base64",
      allOf: [
        {
          pattern:
            "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
        },
        { pattern: CANONICAL_BASE64_PATTERN.source },
      ],
    },
  },
  required: ["kind", "base64"],
  additionalProperties: false,
};

const jsonWireValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "json" },
    value: {},
  },
  required: ["kind", "value"],
  additionalProperties: false,
};

const floatParamWireValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "float" },
    value: { type: "number" },
  },
  required: ["kind", "value"],
  additionalProperties: false,
  description:
    "Explicit SQL REAL parameter. Use when an integral value must remain REAL or a finite REAL exceeds the native numeric range.",
};

const taggedWireValueSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "null" },
        value: { type: "null" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "bool" },
        value: { type: "boolean" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "int" },
        value: { type: "integer" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "float" },
        value: { type: "number" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "text" },
        value: { type: "string" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    blobWireValueSchema,
    jsonWireValueSchema,
  ],
};

const primitiveParamWireValueSchema = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    {
      type: "number",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    { type: "string" },
    blobWireValueSchema,
    jsonWireValueSchema,
    floatParamWireValueSchema,
  ],
  description:
    "Use JSON null, Boolean, safe-magnitude number, or string directly. Use tagged values only for BLOB, SQL JSON, or the explicit REAL escape.",
};

const primitiveResultWireValueSchema = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    blobWireValueSchema,
    jsonWireValueSchema,
  ],
};

const activeParamWireValueSchema =
  roundConfig.wireFormat === "primitive"
    ? primitiveParamWireValueSchema
    : taggedWireValueSchema;
const activeResultWireValueSchema =
  roundConfig.wireFormat === "primitive"
    ? primitiveResultWireValueSchema
    : taggedWireValueSchema;

const executeOutputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          columns: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: {
              type: "array",
              items: activeResultWireValueSchema,
            },
          },
          rowsAffected: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          notices: { type: "array", items: {} },
        },
        required: ["columns", "rows", "rowsAffected", "notices"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const tools = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description:
      "List the workspaces available to the current user. Use this instead of guessing workspace IDs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "active_branch_id",
    title: "Get active branch",
    description:
      "Return the active Lix branch ID for a workspace. SQL execute uses this branch.",
    inputSchema: {
      type: "object",
      properties: { workspace_ref: { type: "string" } },
      required: ["workspace_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "switch_branch",
    title: "Switch active branch",
    description:
      "Switch the active Lix branch used by SQL execute. Never guess the branch ID; query lix_branch first.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_ref: { type: "string" },
        branch_id: { type: "string" },
      },
      required: ["workspace_ref", "branch_id"],
      additionalProperties: false,
    },
  },
  {
    name: "execute",
    title: "Execute raw Lix SQL",
    description: executeDescription(roundConfig),
    inputSchema: {
      type: "object",
      properties: {
        workspace_ref: {
          type: "string",
          description:
            "Exact workspace UUID, exact workspace slug, or exact @namespace/slug. Use the workspace UUID when available.",
        },
        statements: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              sql: { type: "string", minLength: 1 },
              params: {
                type: "array",
                items: activeParamWireValueSchema,
                default: [],
                maxItems: 1000,
              },
            },
            required: ["sql"],
            additionalProperties: false,
          },
        },
      },
      required: ["workspace_ref", "statements"],
      additionalProperties: false,
    },
    outputSchema: executeOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
  },
];

function resolveWorkspace(ref) {
  if (
    ref === WORKSPACE.id ||
    ref === WORKSPACE.slug ||
    ref === `@${WORKSPACE.organization.handle}/${WORKSPACE.slug}`
  ) {
    return WORKSPACE.id;
  }
  throw new Error("Workspace not found.");
}

function fromWire(value) {
  return decodeWireParam(value, {
    wireFormat: roundConfig.wireFormat ?? "tagged",
    Value,
  });
}

function toWire(value) {
  const js = value.toJS();
  if (roundConfig.wireFormat === "primitive") {
    switch (value.kind) {
      case "null":
        return null;
      case "boolean":
        return Boolean(js);
      case "integer":
      case "real":
        return Number(js);
      case "text":
        return String(js);
      case "json":
        return { kind: "json", value: js };
      case "blob":
        return {
          kind: "blob",
          base64: Buffer.from(value.asBytes()).toString("base64"),
        };
    }
  }
  switch (value.kind) {
    case "null":
      return { kind: "null", value: null };
    case "boolean":
      return { kind: "bool", value: Boolean(js) };
    case "integer":
      return { kind: "int", value: Number(js) };
    case "real":
      return { kind: "float", value: Number(js) };
    case "text":
      return { kind: "text", value: String(js) };
    case "json":
      return { kind: "json", value: js };
    case "blob":
      return {
        kind: "blob",
        base64: Buffer.from(value.asBytes()).toString("base64"),
      };
  }
}

function encodeResult(result) {
  return {
    columns: [...result.columns],
    rows: result.rows.map((row) =>
      result.columns.map((column) => toWire(row.value(column))),
    ),
    rowsAffected: result.rowsAffected,
    notices: result.notices.map((notice) => ({ ...notice })),
  };
}

async function executeBatchCompat(statements) {
  const normalized = statements.map((statement) => ({
    sql: statement.sql,
    params: (statement.params ?? []).map(fromWire),
  }));
  if (process.env.AX_EVAL_NATIVE_BATCH === "1") {
    return lix.executeBatch(normalized);
  }

  // The checked-out JS wrapper has executeBatch, but the installed 0.8.4
  // native host behind its compatibility binding predates that method.
  // Production's batch implementation
  // keeps pure reads on the session handle; sequential reads are equivalent in
  // this immutable fixture because no concurrent writer exists during a run.
  if (normalized.every((statement) => isReadOnlySql(statement.sql))) {
    const results = [];
    for (const statement of normalized) {
      results.push(await lix.execute(statement.sql, statement.params));
    }
    return results;
  }

  const transaction = await lix.beginTransaction();
  try {
    const results = [];
    for (const statement of normalized) {
      results.push(await transaction.execute(statement.sql, statement.params));
    }
    await transaction.commit();
    return results;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

function isReadOnlySql(sql) {
  return /^\s*(?:select|with|pragma|explain)\b/i.test(sql);
}

async function seedHoldoutFixtures(lix, encoder) {
  await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
    "/notes/rename-me.md",
    encoder.encode("# Note\nalpha\n"),
  ]);
  await lix.execute("UPDATE lix_file SET data = $1 WHERE path = $2", [
    encoder.encode("# Note\nalpha\nbeta\n"),
    "/notes/rename-me.md",
  ]);
  await lix.execute("UPDATE lix_file SET path = $1 WHERE path = $2", [
    "/notes/renamed.md",
    "/notes/rename-me.md",
  ]);

  await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
    "/notes/deleted.md",
    encoder.encode("# Deleted\nfirst\n"),
  ]);
  await lix.execute("UPDATE lix_file SET data = $1 WHERE path = $2", [
    encoder.encode("# Deleted\nsecond\n"),
    "/notes/deleted.md",
  ]);
  await lix.execute("DELETE FROM lix_file WHERE path = $1", [
    "/notes/deleted.md",
  ]);

  for (const path of [
    "/data_100%/raw/a.md",
    "/data_100%/b.md",
    "/dataX100pct/c.md",
    "/database/d.md",
  ]) {
    await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
      path,
      encoder.encode(`# ${path}\n`),
    ]);
  }

  const issueSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    "x-lix-key": "acme_issue",
    "x-lix-primary-key": ["/project_id", "/issue_number"],
    type: "object",
    required: ["project_id", "issue_number", "title", "status", "owner"],
    properties: {
      project_id: { type: "string" },
      issue_number: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      owner: { type: "string" },
    },
    additionalProperties: false,
  };
  await lix.execute(
    "INSERT INTO lix_registered_schema (value) VALUES (lix_json($1))",
    [JSON.stringify(issueSchema)],
  );
  await lix.execute(
    "INSERT INTO acme_issue (project_id, issue_number, title, status, owner) VALUES ($1, $2, $3, $4, $5)",
    ["launch", "7", "Threat model", "open", "Nia"],
  );
  await lix.execute(
    "UPDATE acme_issue SET status = $1 WHERE project_id = $2 AND issue_number = $3",
    ["in_review", "launch", "7"],
  );
  await lix.execute(
    "UPDATE acme_issue SET status = $1 WHERE project_id = $2 AND issue_number = $3",
    ["closed", "launch", "7"],
  );

  const eventSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    "x-lix-key": "acme_event",
    "x-lix-primary-key": ["/id"],
    type: "object",
    required: ["id", "title", "occurred_on"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      occurred_on: { type: "string" },
    },
    additionalProperties: false,
  };
  await lix.execute(
    "INSERT INTO lix_registered_schema (value) VALUES (lix_json($1))",
    [JSON.stringify(eventSchema)],
  );
  for (const event of [
    ["e1", "July kickoff", "2026-07-03"],
    ["e2", "July ship", "2026-07-31"],
    ["e3", "August kickoff", "2026-08-01"],
    ["e4", "August ship", "2026-08-20"],
  ]) {
    await lix.execute(
      "INSERT INTO acme_event (id, title, occurred_on) VALUES ($1, $2, $3)",
      event,
    );
  }

  await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
    "/draft.md",
    encoder.encode("draft\n"),
  ]);
}

async function seedLix() {
  const lix = await openLix();
  const encoder = new TextEncoder();
  const file = (path, text) => [path, encoder.encode(text)];
  const files = [
    file(
      "/README.md",
      "# Launch Q3\nShared launch workspace.\nTODO: invite final review.",
    ),
    file("/docs/api.md", "# API\nLix SQL API notes.\nTODO: add auth example."),
    file("/docs/guide.md", "# Guide\nHow to use the workspace."),
    file("/docs/archive/old.md", "# Archived\nSuperseded guidance."),
    file("/notes/roadmap.md", "# Roadmap\n- alpha\n"),
    file("/data/sales.csv", "region,revenue\nEU,120\nUS,170\n"),
    file("/status.txt", "main: stable\n"),
  ];
  for (const [path, data] of files) {
    await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
      path,
      data,
    ]);
  }
  await lix.execute("UPDATE lix_file SET data = $1 WHERE path = $2", [
    encoder.encode("# Roadmap\n- alpha\n- beta\n"),
    "/notes/roadmap.md",
  ]);
  await lix.execute("UPDATE lix_file SET data = $1 WHERE path = $2", [
    encoder.encode("# Roadmap\n- alpha\n- beta\n- launch\n"),
    "/notes/roadmap.md",
  ]);

  const taskSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    "x-lix-key": "acme_task",
    "x-lix-primary-key": ["/id"],
    type: "object",
    required: ["id", "title", "done", "priority", "owner", "due_at"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      done: { type: "boolean" },
      priority: { type: "string" },
      owner: { type: "string" },
      due_at: { type: "string" },
    },
    additionalProperties: false,
  };
  await lix.execute(
    "INSERT INTO lix_registered_schema (value) VALUES (lix_json($1))",
    [JSON.stringify(taskSchema)],
  );
  for (const task of [
    ["t1", "Finalize launch brief", false, "high", "Mina", "2026-07-24"],
    ["t2", "Verify analytics", true, "high", "Kai", "2026-07-21"],
    ["t3", "Translate release notes", false, "medium", "Sora", "2026-07-28"],
    ["t4", "Approve pricing page", false, "high", "Jules", "2026-07-23"],
    ["t5", "Archive launch assets", true, "low", "Nia", "2026-07-30"],
  ]) {
    await lix.execute(
      "INSERT INTO acme_task (id, title, done, priority, owner, due_at) VALUES ($1, $2, $3, $4, $5, $6)",
      task,
    );
  }

  const mainBranchId = await lix.activeBranchId();
  const release = await lix.createBranch({
    id: "release-candidate",
    name: "Release candidate",
  });
  await lix.switchBranch({ branchId: release.id });
  await lix.execute("UPDATE lix_file SET data = $1 WHERE path = $2", [
    encoder.encode("release-candidate: awaiting approval\n"),
    "/status.txt",
  ]);
  await lix.execute("INSERT INTO lix_file (path, data) VALUES ($1, $2)", [
    "/release-checklist.md",
    encoder.encode("# Release checklist\n- [ ] approval\n"),
  ]);
  await lix.switchBranch({ branchId: mainBranchId });
  if (fixtureProfile === "holdout") {
    await seedHoldoutFixtures(lix, encoder);
  }
  return lix;
}

const lix = await seedLix();

const server = new Server(
  {
    name:
      fixtureProfile === "default"
        ? `LixRay AX fixture (${round})`
        : `LixRay AX fixture (${round}/${fixtureProfile})`,
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
    instructions:
      "Use LixRay's execute tool for workspace inspection. SQL and branch controls use the workspace's active Lix branch. Use active_branch_id to inspect it and switch_branch to change it. Query lix_branch with execute when you need the branch catalog. Never guess workspace or branch IDs.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "list_workspaces":
        return ok({ workspaces: [WORKSPACE] });
      case "active_branch_id": {
        resolveWorkspace(request.params.arguments?.workspace_ref);
        return ok({ branch_id: await lix.activeBranchId() });
      }
      case "switch_branch": {
        resolveWorkspace(request.params.arguments?.workspace_ref);
        const branchId = request.params.arguments?.branch_id;
        if (typeof branchId !== "string")
          throw new Error("branch_id is required");
        await lix.switchBranch({ branchId });
        return ok({ branch_id: branchId });
      }
      case "execute": {
        resolveWorkspace(request.params.arguments?.workspace_ref);
        const statements = request.params.arguments?.statements;
        if (!Array.isArray(statements) || statements.length === 0) {
          throw new Error("statements must be a non-empty array");
        }
        const results = await executeBatchCompat(statements);
        return ok({ results: results.map(encodeResult) });
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

function ok(structuredContent) {
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await lix.close();
  process.exit(0);
});
