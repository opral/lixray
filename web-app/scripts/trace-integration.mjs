// Invoked by lix-server's opt-in node_client_trace_integration test.
import assert from "node:assert/strict";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { WorkerLixRuntimeClient } from "../src/mcp/runtime-client.ts";
import { withSpan } from "../src/telemetry.ts";

const deadline = setTimeout(() => {
	console.error("Trace integration timed out");
	process.exit(1);
}, 30_000);
deadline.unref();
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({ propagator: new W3CTraceContextPropagator() });
const lixId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const client = new WorkerLixRuntimeClient(
	{},
	{
		userId: accountId,
		token: "test",
		account: {
			id: accountId,
			kind: "person",
			name: "Trace fixture",
			profileUri: "https://example.test/profile",
		},
	},
	async () => null,
	{
		lixFetch: async (_id, request) => {
			const url = new URL(request.url);
			const headers = new Headers(request.headers);
			headers.set("authorization", "Bearer test-internal-token");
			headers.set("x-lix-account-id", accountId);
			return fetch(
				new Request(
					new URL(url.pathname + url.search, process.env.LIX_TRACE_SERVER_URL),
					request,
				),
				{ headers },
			);
		},
	},
);
await withSpan("integration.mcp.tool", async () => {
	try {
		const branch = await client.activeBranchId(lixId);
		await client.transaction(lixId, branch, async (tx) => {
			await tx.execute({
				sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2)",
				params: [
					{ kind: "text", value: "/trace.txt" },
					{ kind: "blob", base64: "aGk=" },
				],
			});
		});
		const checkpoint = await client.execute(lixId, branch, {
			sql: "SELECT commit_id FROM lix_create_checkpoint()",
		});
		assert.ok(checkpoint.rows.length);
	} finally {
		await client.close();
	}
});
await provider.forceFlush();
process.stdout.write(
	JSON.stringify(
		exporter.getFinishedSpans().map((span) => ({
			name: span.name,
			traceId: span.spanContext().traceId,
			spanId: span.spanContext().spanId,
			parentSpanId: span.parentSpanContext?.spanId,
			attributes: span.attributes,
		})),
	),
);
await provider.shutdown();

clearTimeout(deadline);
