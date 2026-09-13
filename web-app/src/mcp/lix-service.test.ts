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
	/** What each path holds, for reads: text, or raw bytes. */
	readonly stored = new Map<string, string | Uint8Array>();
	/** Set to make every read fail, the way a flaky upstream would. */
	readFailure: Error | undefined;
	reads = 0;
	batches = 0;
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
		if (request.sql.startsWith("INSERT INTO lix_file (path, content")) {
			const path = request.params?.[0];
			return {
				columns: ["id", "path"],
				rows: [
					[
						{
							kind: "text" as const,
							value: "00000000-0000-4000-8000-00000000000f",
						},
						path?.kind === "text"
							? path
							: { kind: "text" as const, value: "/unknown" },
					],
				],
				rowsAffected: 1,
				notices: [],
			};
		}
		if (request.sql.startsWith("SELECT id, path, content, lixcol_metadata")) {
			this.reads += 1;
			if (this.readFailure) throw this.readFailure;
			const wanted = (request.params ?? []).flatMap((param) =>
				param.kind === "text" ? [param.value] : [],
			);
			const rows = wanted.flatMap((path, index) => {
				const held = this.stored.get(path);
				if (held === undefined) return [];
				const bytes =
					typeof held === "string" ? new TextEncoder().encode(held) : held;
				return [
					[
						{
							kind: "text" as const,
							value: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
						},
						{ kind: "text" as const, value: path },
						{
							kind: "blob" as const,
							base64: Buffer.from(bytes).toString("base64"),
						},
						{ kind: "null" as const },
					],
				];
			});
			return {
				columns: ["id", "path", "content", "lixcol_metadata"],
				rows,
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
		this.batches += 1;
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

void test("open_lix returns an encrypted context pinned to the selected branch", async () => {
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
	assert.match(opened.context, /^v2\.[^.]+\.[^.]+$/);
	assert.ok(Date.parse(opened.contextExpiresAt) > Date.now());

	const result = await service.execute(opened.context, { sql: "SELECT 1" });
	assert.equal(result.context, opened.context);
	assert.equal(runtime.calls.at(-1)?.branchId, "main");
});

void test("encrypted contexts conceal claims and survive fresh service instances", async () => {
	const runtime = new FakeRuntime();
	const options = {
		contextSigningKey: "test-key",
		principal: { userId: "private-user-id", clientId: "private-client-id" },
	};
	const service = new LixService(runtime, options);
	const opened = await service.openLix(LIX_ID);
	const second = await service.openLix(LIX_ID);
	assert.notEqual(opened.context, second.context);
	const decoded = opened.context
		.split(".")
		.slice(1)
		.map((part) => Buffer.from(part, "base64url").toString("utf8"))
		.join("");
	assert.doesNotMatch(
		decoded,
		/private-user-id|private-client-id|userId|clientId/,
	);
	await new LixService(runtime, options).execute(opened.context, {
		sql: "SELECT 1",
	});
	await assert.rejects(
		new LixService(runtime, {
			...options,
			principal: { ...options.principal, clientId: "other-client" },
		}).execute(opened.context, { sql: "SELECT 1" }),
		(error: unknown) => isLixError(error) && error.code === "invalid_context",
	);
	const parts = opened.context.split(".");
	const bytes = Buffer.from(parts[2], "base64url");
	bytes[0] ^= 1;
	parts[2] = bytes.toString("base64url");
	await assert.rejects(
		service.execute(parts.join("."), { sql: "SELECT 1" }),
		(error: unknown) => isLixError(error) && error.code === "invalid_context",
	);
	await assert.rejects(
		service.execute("eyJ1c2VySWQiOiJwcml2YXRlIn0.signature", {
			sql: "SELECT 1",
		}),
		(error: unknown) => isLixError(error) && error.hint === CONTEXT_REOPEN_HINT,
	);
});

void test("expired contexts provide reopening guidance without diagnostic identifiers", async () => {
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
			assert.equal(error.details, undefined);
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
			error.details === undefined,
	);

	const truncated = opened.context.slice(
		0,
		Math.floor(opened.context.length / 2),
	);
	await assert.rejects(
		service.execute(truncated, { sql: "SELECT 1" }),
		(error: unknown) =>
			isLixError(error) &&
			["malformed_context", "invalid_context"].includes(error.code ?? ""),
	);

	const nonCanonical = `${opened.context}=`;
	await assert.rejects(
		service.execute(nonCanonical, { sql: "SELECT 1" }),
		(error: unknown) => {
			if (!isLixError(error) || error.code !== "malformed_context")
				return false;
			assert.equal(error.hint, CONTEXT_REOPEN_HINT);
			assert.equal(error.details, undefined);
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
			assert.equal(error.details, undefined);
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
			error.details === undefined,
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
			url: "http://localhost:3000/@acme/company/file/AAAAAAAAQACAAAAAAAAAAA/first-name.md",
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
		/\/@new-handle\/company\/file\/IiIiIiIiQiKCIiIiIiIiIg\/moved\/new-title\.md$/,
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

void test("direct SQL targets default to the repository branch without inventory or switching", async () => {
	const runtime = new FakeRuntime();
	runtime.branch = "feature";
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const context = await service.contextForSqlTarget({
		lix_ref: "@acme/company",
	});
	assert.equal(runtime.calls.length, 0);
	assert.equal(runtime.branch, "feature");
	await service.executeBatch(context, { statements: [{ sql: "SELECT 1" }] });
	assert.equal(runtime.calls[0]?.branchId, "main");
	const feature = await service.contextForSqlTarget({
		lix_ref: LIX_ID,
		branch_id: "feature",
	});
	await service.executeBatch(feature, { statements: [{ sql: "SELECT 2" }] });
	assert.equal(runtime.calls[1]?.branchId, "feature");
	assert.equal(
		await service.contextForSqlTarget({ context: feature }),
		feature,
	);
	for (const target of [
		{},
		{ context, lix_ref: LIX_ID },
		{ context, branch_id: "main" },
		{ branch_id: "main" },
		{ lix_ref: "@other/private" },
	]) {
		await assert.rejects(service.contextForSqlTarget(target));
	}
	assert.equal(runtime.calls.length, 2);
});

void test("a preview reads the before side, bounded by what the caller shows", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", "# Notes\n");

	const written = await service.writeFiles(opened.context, {
		originKey: "mcp:test",
		previews: 2,
		files: [
			{ path: "/notes.md", content: { text: "# Notes\n\nAnd more.\n" } },
			{ path: "/new.md", content: { text: "# New\n" } },
			// Past the caller's budget: never read.
			{ path: "/third.md", content: { text: "# Third\n" } },
			// Not Markdown, and not text: neither is previewed.
			{ path: "/data.csv", content: { text: "a,b\n" } },
			{ path: "/image.md", content: { base64: "AAECAw==" } },
		],
	});

	assert.deepEqual(written.previews, [
		{
			path: "/notes.md",
			before: "# Notes\n",
			after: "# Notes\n\nAnd more.\n",
			existed: true,
		},
		{ path: "/new.md", before: "", after: "# New\n", existed: false },
	]);
	// One read for the two targets, not one per file in the write.
	assert.equal(runtime.reads, 1);
});

void test("a preview never costs the write", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", "# Notes\n");
	runtime.readFailure = new Error("upstream is having a day");

	const written = await service.writeFiles(opened.context, {
		originKey: "mcp:test",
		previews: 3,
		files: [{ path: "/notes.md", content: { text: "# Notes again\n" } }],
	});

	// The file is written; there is simply nothing to show.
	assert.equal(written.previews, undefined);
	assert.equal(runtime.batches, 1);
	assert.deepEqual(
		written.files.map((file) => file.path),
		["/notes.md"],
	);
});

void test("a before side that is not text is left uncarded, not called new", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	// A .md path holding bytes no diff can read: empty is text, this is not.
	runtime.stored.set("/notes.md", new Uint8Array([0xff, 0xfe, 0x00]));

	const written = await service.writeFiles(opened.context, {
		originKey: "mcp:test",
		previews: 3,
		files: [{ path: "/notes.md", content: { text: "# Notes\n" } }],
	});

	assert.equal(written.previews, undefined);
});

void test("no previews asked for, no read taken", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", "# Notes\n");

	const written = await service.writeFiles(opened.context, {
		originKey: "mcp:test",
		files: [{ path: "/notes.md", content: { text: "# Notes again\n" } }],
	});

	assert.equal(written.previews, undefined);
	assert.equal(runtime.reads, 0);
});
