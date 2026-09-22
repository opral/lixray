/**
 * execute_sql errors, against the real Lix engine.
 *
 * Everything below the MCP client is production code — the server, the
 * service, the runtime client — over an in-memory Lix instead of the
 * remote server, so the errors are the ones Lix actually raises.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openLix, type Lix } from "@lix-js/sdk";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LixService, type WireValue } from "./lix-service.ts";
import { WorkerLixRuntimeClient } from "./runtime-client.ts";
import { handleMcpTransport, MCP_PROTOCOL_VERSION } from "./server.ts";
import { BINARY_CONTENT_HINT, NAMESPACE_CONFLICT_HINT } from "./sql-errors.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const LIX_REF = "@acme/company";
const UPSERT =
	"INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content";
const MOVE = "UPDATE lix_file SET path = $1 WHERE path = $2";

const text = (value: string): WireValue => ({ kind: "text", value });
const upsert = (path: string, content: string) => ({
	sql: UPSERT,
	params: [text(path), text(content)],
});
const move = (to: string, from: string) => ({
	sql: MOVE,
	params: [text(to), text(from)],
});

type Runtime = WorkerLixRuntimeClient;

/** A runtime whose one Lix is `lix`, and an MCP client in front of it. */
async function connect(
	lix: Lix,
	makeRuntime: (lix: Lix) => Runtime = runtimeFor,
): Promise<{
	runtime: Runtime;
	client: Client;
	call: (name: string, args: Record<string, unknown>) => Promise<CallResult>;
	close: () => Promise<void>;
}> {
	const runtime = makeRuntime(lix);
	const service = new LixService(runtime, {
		contextSigningKey: "execute-sql",
		principal: { userId: "user", clientId: "client" },
	});
	const client = new Client(
		{ name: "execute-sql-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
				}),
		}),
	);
	return {
		runtime,
		client,
		call: async (name, args) =>
			(await client.callTool({ name, arguments: args })) as CallResult,
		close: async () => {
			await client.close();
			await runtime.close();
		},
	};
}

function runtimeFor(lix: Lix): Runtime {
	return new WorkerLixRuntimeClient(
		{},
		{ userId: "user", token: "local" },
		async () => null,
		{
			lixSummaries: [
				{
					id: LIX_ID,
					name: "Company",
					slug: "company",
					namespace: { id: LIX_ID, name: "Acme", handle: "acme" },
				},
			],
			openLix: async () => lix,
		},
	);
}

type CallResult = {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content?: Array<{ type: string; text?: string }>;
	_meta?: Record<string, unknown>;
};

type ToolError = {
	code: string;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
	statement_index?: number;
	outcome?: string;
};

function errorOf(result: CallResult): ToolError {
	assert.equal(result.isError, true, JSON.stringify(result));
	const json = (result.content ?? [])
		.map((block) => block.text ?? "")
		.find((block) => block.startsWith("{"));
	assert.ok(json, "an error carries its JSON text block");
	return (JSON.parse(json) as { error: ToolError }).error;
}

async function head(lix: Lix): Promise<string> {
	const result = await lix.execute(
		"SELECT lix_active_branch_commit_id() AS id",
	);
	return result.rows[0]!.id as string;
}

async function files(
	lix: Lix,
): Promise<Map<string, { id: string; content: string }>> {
	const result = await lix.execute(
		"SELECT id, path, content FROM lix_file WHERE path NOT LIKE '/.lix/%'",
	);
	return new Map(
		result.rows.map((row) => [
			row.path as string,
			{
				id: row.id as string,
				content: new TextDecoder().decode(row.content as Uint8Array),
			},
		]),
	);
}

async function seed(lix: Lix, entries: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(entries))
		await lix.execute(UPSERT, [path, content]);
}

void test("a failed statement rolls back the batch and names its index on both paths", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, { "/a.md": "a", "/b.md": "b" });
		const seen = await head(lix);
		for (const guard of [{}]) {
			const failed = errorOf(
				await call("execute_sql", {
					lix_ref: LIX_REF,
					...guard,
					statements: [upsert("/created.md", "x"), move("/b.md", "/a.md")],
				}),
			);
			assert.equal(failed.code, "LIX_ERROR_UNIQUE");
			assert.equal(failed.statement_index, 1);
			assert.equal(failed.outcome, "not_committed");
			assert.equal(failed.message, "Destination /b.md already exists (file).");
			assert.match(
				failed.hint ?? "",
				new RegExp(NAMESPACE_CONFLICT_HINT.replace(/[.;]/g, "\\$&")),
			);
			assert.equal(await head(lix), seen);
			assert.equal((await files(lix)).has("/created.md"), false);
		}
	} finally {
		await close();
	}
});

void test("errors name the destination path and the BYTEA binding", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, { "/gtm/b.md": "b", "/gtm/archive/b.md": "archived" });
		// A parent that exists is looked up by id.
		const nested = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [move("/gtm/archive/b.md", "/gtm/b.md")],
			}),
		);
		assert.equal(
			nested.message,
			"Destination /gtm/archive/b.md already exists (file).",
		);
		assert.doesNotMatch(nested.message, /[0-9a-f]{8}-[0-9a-f]{4}/);
		// A directory onto a directory, at the root.
		const directory = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					{
						sql: "UPDATE lix_directory SET path = $1 WHERE path = $2",
						params: [text("/gtm"), text("/gtm/archive")],
					},
				],
			}),
		);
		assert.equal(
			directory.message,
			"Destination /gtm already exists (directory).",
		);
		// A parent the rolled-back batch created is named from its parameters.
		const created = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					upsert("/fresh/b.md", "new"),
					move("/fresh/b.md", "/gtm/b.md"),
				],
			}),
		);
		assert.equal(created.statement_index, 1);
		assert.equal(
			created.message,
			"Destination /fresh/b.md already exists (file).",
		);
		// Text straight into the byte column.
		const binary = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					upsert("/ok.md", "fine"),
					{
						sql: "UPDATE lix_file SET content = $1 WHERE path = $2",
						params: [text("text"), text("/gtm/b.md")],
					},
				],
			}),
		);
		assert.equal(binary.code, "LIX_TYPE_MISMATCH");
		assert.equal(binary.statement_index, 1);
		assert.match(
			binary.hint ?? "",
			/^Bind text as CAST\(\$n AS BYTEA\) with a text param\./,
		);
		assert.equal(binary.hint?.startsWith(BINARY_CONTENT_HINT), true);
		assert.equal((await files(lix)).has("/ok.md"), false);
	} finally {
		await close();
	}
});
