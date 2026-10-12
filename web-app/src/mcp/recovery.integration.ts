import assert from "node:assert/strict";
import test from "node:test";
import { openLix } from "@lix-js/sdk";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	NodeTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { WorkerLixRuntimeClient } from "./runtime-client.ts";
import { LixService } from "./lix-service.ts";
import {
	handleMcpTransport,
	MCP_PROTOCOL_VERSION,
	type McpToolCallObservation,
} from "./server.ts";
import { createLixrMcpTelemetrySession } from "../worker/lixr-mcp-telemetry.ts";
import type { EventMessage } from "posthog-node";

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register();
const LIX_ID = "11111111-1111-4111-8111-111111111111";

void test("MCP history, diff, row-ref params and scoped file restoration use the real in-memory engine", async () => {
	const lix = await openLix();
	const runtime = new WorkerLixRuntimeClient(
		{},
		{ userId: "actor", token: "test" },
		() => Promise.resolve(null),
		{
			openLix: () => Promise.resolve(lix),
			lixSummaries: [
				{
					id: LIX_ID,
					name: "Fixture",
					slug: "fixture",
					namespace: { id: "fixture", handle: "fixture", name: "Fixture" },
				},
			],
		},
	);
	const service = new LixService(runtime, {
		contextSigningKey: "test",
		principal: { userId: "actor", clientId: "test" },
	});
	const observations: McpToolCallObservation[] = [];
	const captured: EventMessage[] = [];
	const telemetry = createLixrMcpTelemetrySession(
		{ POSTHOG_PROJECT_TOKEN: "test", POSTHOG_ENVIRONMENT: "production" },
		{ userId: "actor", clientId: "test" },
		{
			createClient: () => ({
				captureImmediate: (event) => {
					captured.push(event);
					return Promise.resolve();
				},
				shutdown: async () => {},
			}),
		},
	)!;
	const client = new Client(
		{ name: "recovery-fixture", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
					onToolCall: (observation) => {
						observations.push(observation);
						telemetry.captureToolFailure(observation);
					},
				}),
		}),
	);
	let token: string | undefined;
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({
			name,
			arguments: {
				...(token ? { context: token } : { lix_ref: LIX_ID }),
				...args,
			},
		});
		assert.notEqual(result.isError, true, JSON.stringify(result));
		const content = result.structuredContent as Record<string, unknown>;
		token = content.context as string;
		return name === "query_sql"
			? (content.result as Record<string, unknown>)
			: content;
	};
	type Cell = { kind: string; value?: unknown; base64?: string };
	type Statement = { columns: string[]; rows: Cell[][] };
	const text = (value: string) => ({ kind: "text", value });
	try {
		const bytes = Buffer.from([0, 255, 7, 128, 65]);
		const created = await call("execute_sql", {
			statements: [
				{
					sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2) RETURNING id",
					params: [
						text("/deleted.bin"),
						{ kind: "blob", base64: bytes.toString("base64") },
					],
				},
			],
		});
		const fileId = (created.results as Statement[])[0]!.rows[0]![0]!
			.value as string;
		const sourceCommit = (created.commit as { after: string }).after;
		await call("execute_sql", {
			statements: [
				{ sql: "DELETE FROM lix_file WHERE id = $1", params: [text(fileId)] },
				{
					sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2)",
					params: [text("/unrelated.bin"), { kind: "blob", base64: "AQID" }],
				},
			],
		});
		const history = (await call("query_sql", {
			sql: "SELECT * FROM lix_history('lix_file') LIMIT 1",
		})) as unknown as Statement;
		const reference = history.rows[0]![history.columns.indexOf("row_ref")]!;
		assert.equal(reference.kind, "row_ref");
		assert.match(String(reference.value), /^lix_row_ref:v2:/);
		const roundTrip = (await call("query_sql", {
			sql: "SELECT $1 AS ref",
			params: [reference],
		})) as unknown as Statement;
		assert.deepEqual(roundTrip.rows[0]![0], reference);
		const diff = (await call("query_sql", {
			sql: "SELECT * FROM lix_diff('lix_file', $1, lix_active_branch_commit_id())",
			params: [text(sourceCommit)],
		})) as unknown as Statement;
		assert.ok(diff.rows.length);
		for (const row of diff.rows)
			assert.equal(row[diff.columns.indexOf("row_ref")]!.kind, "row_ref");
		const restored = await call("execute_sql", {
			statements: [
				{
					sql: "SELECT commit_id FROM lix_restore($1, ARRAY[lix_row_ref('lix_file', NULL, $2)])",
					params: [text(sourceCommit), text(fileId)],
				},
			],
		});
		assert.ok((restored.commit as { after: string }).after);
		assert.equal(
			(restored.results as Statement[])[0]!.rows[0]![0]!.value,
			(restored.commit as { after: string }).after,
		);
		const files = (await call("query_sql", {
			sql: "SELECT id, path, content FROM lix_file WHERE path IN ('/deleted.bin', '/unrelated.bin') ORDER BY path",
		})) as unknown as Statement;
		assert.deepEqual(
			files.rows.map((row) => row[1]!.value),
			["/deleted.bin", "/unrelated.bin"],
		);
		assert.equal(files.rows[0]![0]!.value, fileId);
		assert.equal(files.rows[0]![2]!.base64, bytes.toString("base64"));
		assert.equal(files.rows[1]![2]!.base64, "AQID");

		for (const [sql, code] of [
			[
				"INSERT INTO lix_file (id, path, content) SELECT id, path, content FROM lix_as_of('lix_file', $1) WHERE id = $2",
				"LIX_UNSUPPORTED_SQL",
			],
			[
				"INSERT INTO lix_file (id, path, content) SELECT id, path, CAST(content AS BYTEA) FROM lix_as_of('lix_file', $1) WHERE id = $2",
				"LIX_UNSUPPORTED_SQL",
			],
			[
				"INSERT INTO lix_revert (row_ref) SELECT row_ref FROM lix_diff('lix_file', $1, lix_active_branch_commit_id())",
				"LIX_ERROR_READ_ONLY",
			],
		]) {
			const rejected = await client.callTool({
				name: "execute_sql",
				arguments: {
					context: token,
					statements: [
						{
							sql,
							params: sql!.includes("$2")
								? [text(sourceCommit), text(fileId)]
								: [text(sourceCommit)],
						},
					],
				},
			});
			assert.equal(rejected.isError, true);
			const blocks = rejected.content as Array<{ type: string; text?: string }>;
			const error = (
				JSON.parse(
					blocks.filter((block) => block.type === "text").at(-1)!.text!,
				) as { error: { code: string; outcome: string; hint: string } }
			).error;
			assert.equal(error.code, code);
			assert.equal(error.outcome, "not_committed");
			if (code === "LIX_UNSUPPORTED_SQL") {
				assert.match(error.hint, /lix_restore/);
				assert.doesNotMatch(error.hint, /CAST|CONCAT/);
			}
		}
		const failuresBeforeEncoding = captured.length;

		// Corrupt only the runtime's post-engine result to reproduce a local encoder failure.
		const execute = lix.execute.bind(lix);
		lix.execute = (async (...args: Parameters<typeof lix.execute>) => {
			const result = await execute(...args);
			if (args[0] === "SELECT 1 AS encoding_probe")
				return {
					...result,
					columns: [{ name: "encoding_probe", type: "row_ref" }],
					rows: [{ encoding_probe: "invalid-ref-secret" }],
				};
			return result;
		}) as typeof lix.execute;
		const failed = await client.callTool({
			name: "query_sql",
			arguments: { context: token, sql: "SELECT 1 AS encoding_probe" },
		});
		assert.equal(failed.isError, true);
		await Promise.resolve();
		assert.equal(captured.length, failuresBeforeEncoding + 1);
		assert.equal(captured.at(-1)!.distinctId, "actor");
		assert.equal(
			captured.at(-1)!.properties?.$exception_list &&
				(
					captured.at(-1)!.properties!.$exception_list as Array<{
						type: string;
					}>
				)[0]!.type,
			"McpResultEncodingError",
		);
		const observation = observations.at(-1)!;
		assert.equal(
			captured.at(-1)!.properties?.$otel_trace_id,
			observation.traceId,
		);
		assert.equal(
			captured.at(-1)!.properties?.$otel_span_id,
			observation.spanId,
		);
		assert.doesNotMatch(
			JSON.stringify(captured),
			/invalid-ref-secret|encoding_probe/,
		);
		const transaction = lix.transaction.bind(lix);
		lix.transaction = (async (...args: Parameters<typeof lix.transaction>) => {
			const result = await transaction(...args);
			return {
				...result,
				value: (result.value as import("@lix-js/sdk").StatementResult[]).map(
					(statement) => ({
						...statement,
						columns: [{ name: "ref", type: "row_ref" }],
						rows: [{ ref: "invalid-postcommit-ref" }],
					}),
				),
			};
		}) as typeof lix.transaction;
		const failedWrite = await client.callTool({
			name: "execute_sql",
			arguments: {
				context: token,
				statements: [
					{
						sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2) RETURNING id",
						params: [text("/committed.bin"), { kind: "blob", base64: "BAUG" }],
					},
				],
			},
		});
		assert.equal(failedWrite.isError, true);
		const writeBlocks = failedWrite.content as Array<{
			type: string;
			text?: string;
		}>;
		assert.equal(
			(
				JSON.parse(
					writeBlocks.filter((block) => block.type === "text").at(-1)!.text!,
				) as { error: { outcome: string } }
			).error.outcome,
			"committed",
		);
		await telemetry.flush();
		assert.equal(captured.length, failuresBeforeEncoding + 2);
		assert.equal(captured.at(-1)!.properties?.commit_outcome, "committed");
		assert.doesNotMatch(
			JSON.stringify(captured.at(-1)),
			/committed.bin|invalid-postcommit-ref|BAUG/,
		);
		const persisted = await lix.execute(
			"SELECT OCTET_LENGTH(content) AS n FROM lix_file WHERE path = '/committed.bin'",
		);
		assert.equal(persisted.rows[0]?.n, 3);
	} finally {
		await client.close();
		await runtime.close();
	}
});
