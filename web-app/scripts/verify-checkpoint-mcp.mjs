import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openLix } from "@lix-js/sdk";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LixService } from "../src/mcp/lix-service.ts";
import { WorkerLixRuntimeClient } from "../src/mcp/runtime-client.ts";
import { handleMcpTransport } from "../src/mcp/server.ts";

const lixId = randomUUID();
const runtime = new WorkerLixRuntimeClient(
	{},
	{ userId: "local-trial", token: "local-trial" },
	async () => null,
	{
		openLix: async () => openLix(),
		lixSummaries: [
			{
				id: lixId,
				name: "Checkpoint trial",
				slug: "checkpoint-trial",
				namespace: { id: randomUUID(), name: "Local", handle: "local" },
			},
		],
	},
);
const service = new LixService(runtime, {
	contextSigningKey: "local-checkpoint-trial-key",
	principal: { userId: "local-trial", clientId: "local-trial" },
});
const transport = new StreamableHTTPClientTransport(
	new URL("https://local.test/mcp"),
	{
		fetch: (input, init) =>
			handleMcpTransport(new Request(input, init), service, {
				authMode: "none",
				serverName: "LixRay_Local_Checkpoint_Trial",
			}),
	},
);
const client = new Client({ name: "checkpoint-trial", version: "1.0.0" });
try {
	await client.connect(transport);
	const opened = await client.callTool({
		name: "open_lix",
		arguments: { lix_ref: lixId },
	});
	assert.equal(opened.isError, undefined, JSON.stringify(opened.content));
	const context = opened.structuredContent.context;
	const schema = await client.callTool({
		name: "query_sql",
		arguments: {
			context,
			sql: "SELECT description FROM information_schema.columns WHERE table_name = 'lix_comment' AND column_name = 'body'",
		},
	});
	assert.equal(schema.isError, undefined, JSON.stringify(schema.content));
	assert.match(
		JSON.stringify(schema.structuredContent),
		/packages\/lix\/vendor\/zettel\/schema.json/,
	);
	const description =
		"Changed the import guard to reject malformed rows; existing files still open.";
	const checkpoint = await client.callTool({
		name: "create_checkpoint",
		arguments: { context, description },
	});
	assert.equal(
		checkpoint.isError,
		undefined,
		JSON.stringify(checkpoint.content),
	);
	const commitId = checkpoint.structuredContent.commit_id;
	const note = await client.callTool({
		name: "query_sql",
		arguments: {
			context,
			sql: `SELECT note.body FROM lix_conversation AS thread
            JOIN lix_comment AS note ON note.conversation_id = thread.id
            WHERE thread.target = lix_row_ref('lix_commit', NULL, $1)
              AND thread.lixcol_global = true`,
			params: [{ kind: "text", value: commitId }],
		},
	});
	assert.equal(note.isError, undefined, JSON.stringify(note.content));
	assert.match(
		JSON.stringify(note.structuredContent),
		/Changed the import guard/,
	);
	const batchDescription =
		"Added an import status key so the next agent can inspect the workflow.";
	const batch = await client.callTool({
		name: "execute_sql",
		arguments: {
			context,
			statements: [
				{
					sql: "INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
					params: [
						{ kind: "text", value: "import-status" },
						{ kind: "text", value: "ready" },
					],
				},
			],
			checkpoint: { description: batchDescription },
		},
	});
	assert.equal(batch.isError, undefined, JSON.stringify(batch.content));
	const batchCommitId = batch.structuredContent.checkpoint_commit_id;
	assert.match(batchCommitId, /^[0-9a-f-]+$/);
	const batchNote = await client.callTool({
		name: "query_sql",
		arguments: {
			context,
			sql: `SELECT note.body FROM lix_conversation AS thread
            JOIN lix_comment AS note ON note.conversation_id = thread.id
            WHERE thread.target = lix_row_ref('lix_commit', NULL, $1)
              AND thread.lixcol_global = true`,
			params: [{ kind: "text", value: batchCommitId }],
		},
	});
	assert.equal(batchNote.isError, undefined, JSON.stringify(batchNote.content));
	assert.match(
		JSON.stringify(batchNote.structuredContent),
		/Added an import status key/,
	);
	const retried = await client.callTool({
		name: "describe_checkpoint",
		arguments: {
			context,
			commit_id: batchCommitId,
			description: `${batchDescription} Reviewed.`,
		},
	});
	assert.equal(retried.isError, undefined, JSON.stringify(retried.content));
	const count = await client.callTool({
		name: "query_sql",
		arguments: {
			context,
			sql: "SELECT COUNT(*) AS count FROM lix_comment WHERE id = $1 AND lixcol_global = true",
			params: [{ kind: "text", value: batchCommitId }],
		},
	});
	assert.equal(count.isError, undefined, JSON.stringify(count.content));
	assert.match(JSON.stringify(count.structuredContent), /"value":1/);
	const corrected = await client.callTool({
		name: "query_sql",
		arguments: {
			context,
			sql: "SELECT body FROM lix_comment WHERE id = $1 AND lixcol_global = true",
			params: [{ kind: "text", value: batchCommitId }],
		},
	});
	assert.equal(corrected.isError, undefined, JSON.stringify(corrected.content));
	assert.match(JSON.stringify(corrected.structuredContent), /Reviewed/);
	console.log(
		`Local MCP standalone and batch checkpoints described: ${commitId}, ${batchCommitId}`,
	);
} finally {
	await client.close();
	await runtime.close();
}
