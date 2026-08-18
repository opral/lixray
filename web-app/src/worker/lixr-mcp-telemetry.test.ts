import assert from "node:assert/strict";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	analyzeSqlOperation,
	computeContentHash,
	createLixrMcpTelemetrySession,
	detectFileWrites,
	getFileExtension,
} from "./lixr-mcp-telemetry.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

void test("Lixr MCP telemetry captures lixr_file_written event", async () => {
	const captured: Array<EventMessage> = [];
	let shutdowns = 0;
	const session = createLixrMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_HOST: "https://posthog.example",
			POSTHOG_ENVIRONMENT: "production",
			RAILWAY_GIT_COMMIT_SHA: "worker-version-123",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
		{
			createClient: (token, options) => {
				assert.equal(token, "project-token");
				assert.deepEqual(options, {
					host: "https://posthog.example",
					flushAt: 1,
					flushInterval: 0,
				});
				return {
					captureImmediate: async (event) => {
						captured.push(structuredClone(event));
					},
					shutdown: async () => {
						shutdowns += 1;
					},
				};
			},
		},
	);
	assert.ok(session);

	session.captureFileWritten({
		file_path: "/skills/my-skill.md",
		file_extension: "md",
		char_count: 1000,
		byte_count: 1024,
		content_sha256:
			"abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
		is_bulk: false,
		source: "mcp",
		verified: true,
		hash_match: true,
		lix_id: LIX_ID,
		repository_id: LIX_ID,
	});
	await session.flush();

	assert.equal(shutdowns, 1);
	assert.equal(captured.length, 1);
	const event = captured[0];
	assert.equal(event?.distinctId, "user-123");
	assert.equal(event?.event, "lixr_file_written");
	assert.deepEqual(event?.groups, { lix: LIX_ID });
	assert.equal(event?.properties?.file_path, "/skills/my-skill.md");
	assert.equal(event?.properties?.file_extension, "md");
	assert.equal(event?.properties?.char_count, 1000);
	assert.equal(event?.properties?.byte_count, 1024);
});

void test("Lixr MCP telemetry captures lixr_first_file_added event", async () => {
	const captured: Array<EventMessage> = [];
	const session = createLixrMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
		{
			createClient: () => ({
				captureImmediate: async (event) => {
					captured.push(structuredClone(event));
				},
				shutdown: async () => undefined,
			}),
		},
	);
	assert.ok(session);

	session.captureFirstFileAdded({
		file_path: "/first-file.md",
		file_extension: "md",
		char_count: 100,
		byte_count: 102,
		content_sha256:
			"def456abc123def456abc123def456abc123def456abc123def456abc123def4",
		is_bulk: false,
		source: "mcp",
		verified: true,
		hash_match: true,
		lix_id: LIX_ID,
		repository_id: LIX_ID,
	});
	await session.flush();

	assert.equal(captured[0]?.event, "lixr_first_file_added");
	assert.equal(captured[0]?.properties?.file_path, "/first-file.md");
	assert.equal(captured[0]?.properties?.file_extension, "md");
});

void test("Lixr MCP telemetry captures lixr_import_completed event", async () => {
	const captured: Array<EventMessage> = [];
	const session = createLixrMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
		{
			createClient: () => ({
				captureImmediate: async (event) => {
					captured.push(structuredClone(event));
				},
				shutdown: async () => undefined,
			}),
		},
	);
	assert.ok(session);

	session.captureImportCompleted({
		file_count: 29,
		char_count: 124000,
		byte_count: 126000,
		tool_call_count: 32,
		duration_ms: 15000,
		is_bulk: true,
		lix_id: LIX_ID,
		repository_id: LIX_ID,
	});
	await session.flush();

	assert.equal(captured[0]?.event, "lixr_import_completed");
	assert.equal(captured[0]?.properties?.file_count, 29);
	assert.equal(captured[0]?.properties?.char_count, 124000);
	assert.equal(captured[0]?.properties?.byte_count, 126000);
	assert.equal(captured[0]?.properties?.tool_call_count, 32);
	assert.equal(captured[0]?.properties?.is_bulk, true);
	assert.doesNotMatch(JSON.stringify(captured), /private|secret|confidential/i);
});

void test("Lixr MCP telemetry does not log file content", async () => {
	const captured: Array<EventMessage> = [];
	const session = createLixrMcpTelemetrySession(
		{
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{ userId: "user-123", clientId: "oauth-client-456" },
		{
			createClient: () => ({
				captureImmediate: async (event) => {
					captured.push(structuredClone(event));
				},
				shutdown: async () => undefined,
			}),
		},
	);
	assert.ok(session);

	session.captureFileWritten({
		file_path: "/private-file.txt",
		file_extension: "txt",
		char_count: 50,
		byte_count: 50,
		content_sha256:
			"secrethashsecrethashsecrethashsecrethashsecrethashsecrethashsecr",
		is_bulk: false,
		source: "mcp",
		verified: true,
		hash_match: true,
		lix_id: LIX_ID,
		repository_id: LIX_ID,
	});
	await session.flush();

	assert.equal(captured[0]?.event, "lixr_file_written");
	assert.equal(captured[0]?.properties?.file_path, "/private-file.txt");
	assert.equal(
		typeof captured[0]?.properties?.content_sha256 === "string"
			? captured[0].properties.content_sha256.length
			: 0,
		64,
	);
	assert.doesNotMatch(
		JSON.stringify(captured),
		/private content|secret data|confidential/i,
	);
});

void test("Lixr MCP telemetry is disabled without production configuration", () => {
	let clientCreations = 0;
	const createClient = () => {
		clientCreations += 1;
		throw new Error("client should not be created");
	};

	assert.equal(
		createLixrMcpTelemetrySession(
			{ POSTHOG_ENVIRONMENT: "production" },
			{ userId: "user-123", clientId: "client-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createLixrMcpTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "preview",
			},
			{ userId: "user-123", clientId: "client-123" },
			{ createClient },
		),
		null,
	);
	assert.equal(
		createLixrMcpTelemetrySession(
			{
				POSTHOG_PROJECT_TOKEN: "token",
				POSTHOG_ENVIRONMENT: "production",
			},
			{ userId: "demo", clientId: "demo", isDemo: true },
			{ createClient },
		),
		null,
	);
	assert.equal(clientCreations, 0);
});

void test("analyzeSqlOperation detects bulk inserts", () => {
	const result = analyzeSqlOperation({
		statementCount: 3,
		statements: [
			{
				operation: "INSERT",
				sanitizedSql: "INSERT INTO lix_file VALUES (?, ?, ?)",
				shapeId: "shape1",
			},
			{
				operation: "INSERT",
				sanitizedSql: "INSERT INTO lix_file VALUES (?, ?, ?)",
				shapeId: "shape1",
			},
			{
				operation: "INSERT",
				sanitizedSql: "INSERT INTO lix_file VALUES (?, ?, ?)",
				shapeId: "shape1",
			},
		],
	});

	assert.equal(result.operation, "INSERT");
	assert.equal(result.isBulk, true);
	assert.equal(result.estimatedRowCount, 3);
});

void test("detectFileWrites identifies file insert operations", () => {
	const writes = detectFileWrites([
		{
			sql: "INSERT INTO lix_file (id, path, content) VALUES ($1, $2, $3)",
			params: [
				{ kind: "text", value: "file-id-123" },
				{ kind: "text", value: "/skills/my-skill.md" },
				{
					kind: "text",
					value: "# My Skill\n\nThis is a skill file with lots of content.",
				},
			],
		},
	]);

	assert.equal(writes.length, 1);
	assert.equal(writes[0]?.path, "/skills/my-skill.md");
	assert.equal(writes[0]?.operation, "insert");
	assert.ok(writes[0]?.content);
	assert.match(writes[0]?.content ?? "", /My Skill/);
});

void test("detectFileWrites identifies file update operations", () => {
	const writes = detectFileWrites([
		{
			sql: "UPDATE lix_file SET content = $1 WHERE path = $2",
			params: [
				{
					kind: "text",
					value: "# Updated content\n\nThis is updated content.",
				},
				{ kind: "text", value: "/docs/readme.md" },
			],
		},
	]);

	assert.equal(writes.length, 1);
	assert.equal(writes[0]?.path, "/docs/readme.md");
	assert.equal(writes[0]?.operation, "update");
});

void test("detectFileWrites handles multiple file operations", () => {
	const writes = detectFileWrites([
		{
			sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2)",
			params: [
				{ kind: "text", value: "/file1.txt" },
				{ kind: "text", value: "Content 1" },
			],
		},
		{
			sql: "UPDATE lix_file SET content = $1 WHERE path = $2",
			params: [
				{ kind: "text", value: "Content 2" },
				{ kind: "text", value: "/file2.txt" },
			],
		},
		{
			sql: "DELETE FROM lix_file WHERE path = $1",
			params: [{ kind: "text", value: "/file3.txt" }],
		},
	]);

	assert.equal(writes.length, 3);
	assert.equal(writes[0]?.operation, "insert");
	assert.equal(writes[1]?.operation, "update");
	assert.equal(writes[2]?.operation, "delete");
});

void test("computeContentHash generates consistent SHA-256 hashes", () => {
	const content = "Hello, World!";
	const hash1 = computeContentHash(content);
	const hash2 = computeContentHash(content);

	assert.equal(hash1, hash2);
	assert.equal(hash1.length, 64);
	assert.match(hash1, /^[0-9a-f]{64}$/);
});

void test("getFileExtension extracts file extensions", () => {
	assert.equal(getFileExtension("/path/to/file.md"), "md");
	assert.equal(getFileExtension("/skills/my-skill.ts"), "ts");
	assert.equal(getFileExtension("readme.txt"), "txt");
	assert.equal(getFileExtension("/no-extension"), "");
	assert.equal(getFileExtension("/file.with.multiple.dots.json"), "json");
});
