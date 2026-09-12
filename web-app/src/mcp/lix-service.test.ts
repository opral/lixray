import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTEXT_REOPEN_HINT,
	LixService,
	OPEN_LIX_FILE_MANIFEST_SQL,
	OPEN_LIX_INVENTORY_SQL,
	isLixError,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type LixRuntimeClient,
} from "./lix-service.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

class FakeRuntime implements LixRuntimeClient {
	branch = "main";
	commit = 0;
	fileCount = 0;
	directoryCount = 0;
	filePaths: Array<string> = [];
	restoreCommitId: string | undefined;
	readonly opened = new Set<string>();
	readonly calls: Array<{
		lixId: string;
		branchId: string;
		sql?: string;
		params?: ExecuteRequest["params"];
	}> = [];

	hasOpenRuntime(lixId: string) {
		return this.opened.has(lixId);
	}

	private admit(lixId: string) {
		this.opened.add(lixId);
	}

	async listLixes() {
		return [
			{
				id: LIX_ID,
				name: "Company",
				slug: "company",
				namespace: { id: "n", name: "Acme", handle: "acme" },
			},
		];
	}

	async activeBranchId(lixId: string, branchId?: string) {
		this.admit(lixId);
		if (branchId) this.branch = branchId;
		return this.branch;
	}

	async defaultBranchId() {
		return "main";
	}
	async switchBranch(lixId: string, branchId: string) {
		this.admit(lixId);
		this.branch = branchId;
		return { branchId };
	}

	async execute(lixId: string, branchId: string, request: ExecuteRequest) {
		this.admit(lixId);
		this.calls.push({
			lixId,
			branchId,
			sql: request.sql,
			params: request.params,
		});
		if (
			request.sql ===
			"INSERT INTO lix_restore (commit_id) VALUES ($1) RETURNING commit_id"
		) {
			return {
				columns: ["commit_id"],
				rows: [
					[
						this.restoreCommitId === undefined
							? (request.params?.[0] ?? { kind: "null" as const })
							: { kind: "text" as const, value: this.restoreCommitId },
					],
				],
				rowsAffected: 1,
				notices: [],
			};
		}
		if (request.sql === "SELECT commit_id FROM lix_create_checkpoint()") {
			this.commit += 1;
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: `commit-${this.commit}` }]],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (request.sql.includes("lix_active_branch_commit_id")) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: `commit-${this.commit}` }]],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (request.sql === OPEN_LIX_INVENTORY_SQL) {
			return {
				columns: ["file_count", "directory_count"],
				rows: [
					[
						{ kind: "int" as const, value: this.fileCount },
						{ kind: "int" as const, value: this.directoryCount },
					],
				],
				rowsAffected: 0,
				notices: [],
			};
		}
		if (request.sql === OPEN_LIX_FILE_MANIFEST_SQL) {
			return {
				columns: ["id", "path"],
				rows: this.filePaths.map((path, index) => [
					{
						kind: "text" as const,
						value: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
					},
					{ kind: "text" as const, value: path },
				]),
				rowsAffected: 0,
				notices: [],
			};
		}
		return { columns: [], rows: [], rowsAffected: 1, notices: [] };
	}

	async executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	) {
		return {
			results: await Promise.all(
				request.statements.map((statement) =>
					this.execute(lixId, branchId, statement),
				),
			),
		};
	}

	async createBranch() {
		return { id: "draft", name: "Draft", hidden: false, commitId: "commit-0" };
	}
	async undo() {
		return {
			branchId: this.branch,
			targetCommitId: "old",
			inverseCommitId: "inverse",
		};
	}
	async redo() {
		return {
			branchId: this.branch,
			targetCommitId: "next",
			replayCommitId: "replay",
		};
	}
	async mergeBranchPreview() {
		return { outcome: "alreadyUpToDate" };
	}
	async mergeBranch() {
		return { outcome: "mergeCommitted" };
	}
}

void test("open_lix returns a signed context pinned to the selected branch", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	assert.equal(opened.lixId, LIX_ID);
	assert.equal(opened.lixRef, "@acme/company");
	assert.equal(opened.name, "Company");
	assert.equal(opened.branchId, "main");
	assert.equal(opened.fileCount, 0);
	assert.equal(opened.directoryCount, 0);
	assert.equal(opened.empty, true);
	assert.match(opened.context, /^[^.]+\.[^.]+$/);
	assert.ok(Date.parse(opened.contextExpiresAt) > Date.now());

	const result = await service.execute(opened.context, { sql: "SELECT 1" });
	assert.equal(result.context, opened.context);
	assert.equal(runtime.calls.at(-1)?.branchId, "main");
});

void test("expired contexts identify the Lix and branch needed to reopen", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
		contextTtlMs: -1,
	});
	const opened = await service.openLix(LIX_ID);
	await assert.rejects(
		service.execute(opened.context, { sql: "SELECT 1" }),
		(error: unknown) => {
			if (!isLixError(error) || error.code !== "context_expired") return false;
			assert.equal(error.hint, CONTEXT_REOPEN_HINT);
			assert.match(error.hint ?? "", /structuredContent\.context/);
			assert.match(error.hint ?? "", /do not copy TEXT/);
			const details = error.details as Record<string, unknown>;
			assert.equal(typeof details.server_time, "string");
			assert.ok(Date.parse(String(details.server_time)));
			assert.equal(typeof details.expires_at, "string");
			assert.ok(Date.parse(String(details.expires_at)));
			assert.equal(details.lix_id, LIX_ID);
			assert.equal(details.branch_id, "main");
			assert.doesNotMatch(JSON.stringify(error), new RegExp(opened.context));
			return true;
		},
	);
});

void test("open_lix reports file and directory counts for a populated lix", async () => {
	const runtime = new FakeRuntime();
	runtime.fileCount = 3;
	runtime.directoryCount = 2;
	runtime.filePaths = ["/a.md", "/b.md", "/c.md"];
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID);
	assert.equal(opened.fileCount, 3);
	assert.equal(opened.directoryCount, 2);
	assert.deepEqual(opened.filePaths, ["/a.md", "/b.md", "/c.md"]);
	assert.equal(opened.filePathsComplete, true);
	assert.equal(opened.empty, false);
	assert.equal(
		runtime.calls.some((call) => call.sql === OPEN_LIX_INVENTORY_SQL),
		true,
	);
	assert.equal(
		runtime.calls.some((call) => call.sql === OPEN_LIX_FILE_MANIFEST_SQL),
		true,
	);
});

void test("open_lix marks a bounded file manifest incomplete", async () => {
	const runtime = new FakeRuntime();
	runtime.fileCount = 3;
	runtime.filePaths = ["/a.md", "/b.md"];
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID);
	assert.deepEqual(opened.filePaths, ["/a.md", "/b.md"]);
	assert.equal(opened.filePathsComplete, false);
});

void test("switch_branch returns a new context and never mutates the old handle", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const main = await service.openLix(LIX_ID);
	const draft = await service.switchBranch(main.context, "draft");
	assert.notEqual(draft.context, main.context);
	assert.equal(draft.branchId, "draft");
	await service.execute(main.context, { sql: "SELECT main" });
	assert.equal(runtime.calls.at(-1)?.branchId, "main");
	await service.execute(draft.context, { sql: "SELECT draft" });
	assert.equal(runtime.calls.at(-1)?.branchId, "draft");
});

void test("restore uses one parameterized SQL command on the context branch", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID, "draft");
	runtime.calls.length = 0;
	const restored = await service.restore(opened.context, "commit-target");

	assert.deepEqual(restored, {
		context: opened.context,
		branchId: "draft",
		commitId: "commit-target",
	});
	assert.deepEqual(runtime.calls, [
		{
			lixId: LIX_ID,
			branchId: "draft",
			sql: "INSERT INTO lix_restore (commit_id) VALUES ($1) RETURNING commit_id",
			params: [{ kind: "text", value: "commit-target" }],
		},
	]);
});

void test("checkpoint uses the canonical SQL function on the context branch", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID, "draft");
	runtime.calls.length = 0;

	const checkpoint = await service.createCheckpoint(opened.context);

	assert.equal(checkpoint.commitId, "commit-1");
	assert.deepEqual(runtime.calls, [
		{
			lixId: LIX_ID,
			branchId: "draft",
			sql: "SELECT commit_id FROM lix_create_checkpoint()",
			params: undefined,
		},
	]);
});

void test("restore rejects a mismatched commit id from Lix", async () => {
	const runtime = new FakeRuntime();
	runtime.restoreCommitId = "unexpected-commit";
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID, "draft");

	await assert.rejects(
		service.restore(opened.context, "commit-target"),
		(error: unknown) =>
			error instanceof Error &&
			error.message === "Lix did not confirm the requested restore commit id.",
	);
});

void test("contexts are bound to the principal and reject tampering", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID);

	await assert.rejects(
		service.execute("not-a-context", { sql: "SELECT 1" }),
		(error: unknown) =>
			isLixError(error) &&
			error.code === "malformed_context" &&
			error.hint === CONTEXT_REOPEN_HINT &&
			typeof (error.details as { server_time?: unknown }).server_time ===
				"string",
	);

	const truncated = opened.context.slice(
		0,
		Math.floor(opened.context.length / 2),
	);
	await assert.rejects(
		service.execute(truncated, { sql: "SELECT 1" }),
		(error: unknown) => isLixError(error) && error.code === "malformed_context",
	);

	const [encodedClaims, encodedSignature] = opened.context.split(".");
	const nonCanonical = `${encodedClaims}.${encodedSignature}=`;
	await assert.rejects(
		service.execute(nonCanonical, { sql: "SELECT 1" }),
		(error: unknown) => {
			if (!isLixError(error) || error.code !== "malformed_context")
				return false;
			assert.equal(error.hint, CONTEXT_REOPEN_HINT);
			const details = error.details as Record<string, unknown>;
			assert.equal(typeof details.server_time, "string");
			assert.equal(typeof details.expires_at, "string");
			return true;
		},
	);

	const otherKey = new LixService(runtime, {
		contextSigningKey: "other-key",
		principal: { userId: "user", clientId: "client" },
	});
	await assert.rejects(
		otherKey.execute(opened.context, { sql: "SELECT 1" }),
		(error: unknown) => {
			if (!isLixError(error) || error.code !== "invalid_context") return false;
			assert.equal(error.hint, CONTEXT_REOPEN_HINT);
			const details = error.details as Record<string, unknown>;
			assert.equal(typeof details.server_time, "string");
			assert.equal(typeof details.expires_at, "string");
			assert.equal(details.lix_id, undefined);
			return true;
		},
	);

	const otherPrincipal = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "other-user", clientId: "client" },
	});
	await assert.rejects(
		otherPrincipal.execute(opened.context, { sql: "SELECT 1" }),
		(error: unknown) =>
			isLixError(error) &&
			error.code === "invalid_context" &&
			error.hint === CONTEXT_REOPEN_HINT &&
			typeof (error.details as { expires_at?: unknown }).expires_at ===
				"string",
	);
});

const FILE_ID = "22222222-2222-4222-8222-222222222222";
const DIR_ID = "33333333-3333-4333-8333-333333333333";
class EntityRuntime extends FakeRuntime {
	entities = [
		{ kind: "file", id: FILE_ID, path: "/notes/First name.md" },
		{ kind: "directory", id: DIR_ID, path: "/notes" },
	];
	visible = true;
	handle = "acme";
	override async listLixes() {
		const rows = await super.listLixes();
		return this.visible
			? rows.map((row) => ({
					...row,
					namespace: { ...row.namespace, handle: this.handle },
				}))
			: [];
	}
	override async execute(
		lixId: string,
		branchId: string,
		request: ExecuteRequest,
	) {
		if (
			!request.sql.startsWith("SELECT id, path FROM lix_") ||
			request.sql === OPEN_LIX_FILE_MANIFEST_SQL
		)
			return super.execute(lixId, branchId, request);
		this.calls.push({
			lixId,
			branchId,
			sql: request.sql,
			params: request.params,
		});
		const kind = request.sql.includes("FROM lix_file ") ? "file" : "directory";
		const selectors = [...request.sql.matchAll(/(id|path) = \$(\d+)/g)];
		const matches = this.entities.filter(
			(entity) =>
				entity.kind === kind &&
				selectors.some((match) => {
					const param = request.params?.[Number(match[2]) - 1];
					return (
						param?.kind === "text" &&
						entity[match[1] as "id" | "path"] === param.value
					);
				}),
		);
		return {
			columns: ["id", "path"],
			rows: matches.map((entity) => [
				{ kind: "text" as const, value: entity.id },
				{ kind: "text" as const, value: entity.path },
			]),
			rowsAffected: 0,
			notices: [],
		};
	}
}
const makeService = (runtime: FakeRuntime) =>
	new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
void test("manifest includes verified UUID links and names no branch on the default branch", async () => {
	const runtime = new FakeRuntime();
	runtime.fileCount = 1;
	runtime.filePaths = ["/First name.md"];
	const opened = await makeService(runtime).openLix(
		LIX_ID,
		undefined,
		"http://localhost:3000",
	);
	assert.equal(opened.url, "http://localhost:3000/@acme/company");
	assert.deepEqual(opened.files, [
		{
			id: "00000000-0000-4000-8000-000000000000",
			path: "/First name.md",
			url: "http://localhost:3000/@acme/company/file/AAAAAAAAQACAAAAAAAAAAA/First%20name.md",
		},
	]);
});
void test("entity URLs batch by kind, preserve request order and use the signed branch", async () => {
	const runtime = new EntityRuntime();
	const service = makeService(runtime);
	const opened = await service.openLix(LIX_ID, "draft/review");
	runtime.branch = "different";
	runtime.calls.length = 0;
	const result = await service.getEntityUrls(opened.context, [
		{ kind: "directory", path: "/notes/" },
		{ kind: "file", id: FILE_ID },
		{ kind: "file", path: "/notes/First name.md" },
		{ kind: "directory", path: "/" },
	]);
	assert.equal(result.context, opened.context);
	assert.equal(runtime.calls.length, 2);
	assert.ok(
		runtime.calls.every(
			(call) =>
				call.lixId === LIX_ID &&
				call.branchId === "draft/review" &&
				call.sql?.startsWith("SELECT "),
		),
	);
	assert.equal(
		result.entities[0]?.url,
		"https://lixray.com/@acme/company/folder/MzMzMzMzQzODMzMzMzMzMw/notes?branch=draft%2Freview",
	);
	assert.equal(result.entities[1]?.url, result.entities[2]?.url);
	assert.deepEqual(result.entities[3], {
		kind: "directory",
		id: null,
		path: "/",
		url: "https://lixray.com/@acme/company?branch=draft%2Freview",
	});
});
void test("UUID lookup follows file and directory renames and current namespace handles", async () => {
	const runtime = new EntityRuntime();
	const service = makeService(runtime);
	const opened = await service.openLix(LIX_ID);
	runtime.entities[0]!.path = "/moved/New title.md";
	runtime.entities[1]!.path = "/moved";
	runtime.handle = "new-handle";
	const result = await service.getEntityUrls(opened.context, [
		{ kind: "file", id: FILE_ID },
		{ kind: "directory", id: DIR_ID },
	]);
	// The id is the identity; the URL carries the path the entity has now.
	assert.match(
		result.entities[0]!.url,
		/\/@new-handle\/company\/file\/IiIiIiIiQiKCIiIiIiIiIg\/moved\/New%20title\.md$/,
	);
	assert.equal(result.entities[1]!.path, "/moved");
	assert.match(
		result.entities[1]!.url,
		/\/@new-handle\/company\/folder\/[A-Za-z0-9_-]{22}\/moved$/,
	);
	await assert.rejects(
		service.getEntityUrls(opened.context, [
			{ kind: "file", path: "/notes/First name.md" },
		]),
		(error: unknown) => isLixError(error) && error.code === "not_found",
	);
});
void test("missing UUIDs, wrong kinds and revoked repository access never fabricate links", async () => {
	const runtime = new EntityRuntime();
	const service = makeService(runtime);
	const opened = await service.openLix(LIX_ID);
	for (const selector of [
		{ kind: "directory" as const, id: FILE_ID },
		{ kind: "file" as const, id: LIX_ID },
	])
		await assert.rejects(
			service.getEntityUrls(opened.context, [selector]),
			(error: unknown) => isLixError(error) && error.code === "not_found",
		);
	runtime.visible = false;
	runtime.calls.length = 0;
	await assert.rejects(
		service.getEntityUrls(opened.context, [{ kind: "directory", path: "/" }]),
		(error: unknown) => isLixError(error) && error.code === "not_found",
	);
	assert.equal(runtime.calls.length, 0);
});
void test("entity URL lookup rejects tampered contexts and invalid selectors before reading entities", async () => {
	const runtime = new EntityRuntime();
	const service = makeService(runtime);
	const opened = await service.openLix(LIX_ID);
	runtime.calls.length = 0;
	await assert.rejects(
		service.getEntityUrls(opened.context + "x", [
			{ kind: "file", id: FILE_ID },
		]),
	);
	for (const selectors of [
		[],
		Array.from({ length: 51 }, () => ({ kind: "file" as const, id: FILE_ID })),
		[{ kind: "file" as const, id: FILE_ID, path: "/a" }],
		[{ kind: "directory" as const, path: "" }],
		[{ kind: "file" as const, path: "/a/../b" }],
	])
		await assert.rejects(
			service.getEntityUrls(opened.context, selectors),
			(error: unknown) => isLixError(error) && error.code === "invalid_request",
		);
	assert.equal(runtime.calls.length, 0);
});

void test("root directory UUID uses the repository URL and SQL-sensitive paths stay bound", async () => {
	const runtime = new EntityRuntime();
	const service = makeService(runtime);
	const opened = await service.openLix(LIX_ID);
	runtime.entities[1]!.path = "/";
	runtime.entities[0]!.path = "/notes/quote' OR 1=1 --.md";
	runtime.calls.length = 0;
	const result = await service.getEntityUrls(opened.context, [
		{ kind: "directory", id: DIR_ID },
		{ kind: "file", path: runtime.entities[0]!.path },
	]);
	assert.deepEqual(result.entities[0], {
		kind: "directory",
		id: null,
		path: "/",
		url: "https://lixray.com/@acme/company",
	});
	assert.ok(
		runtime.calls.every(
			(call) => !call.sql?.includes("quote'") && call.sql?.endsWith("LIMIT 50"),
		),
	);
	assert.deepEqual(runtime.calls[0]!.params, [
		{ kind: "text", value: runtime.entities[0]!.path },
	]);
});
