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
	type TransactionClient,
	type LixRuntimeClient,
} from "./lix-service.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

class FakeRuntime implements LixRuntimeClient {
	branch = "main";
	commit = 0;
	fileCount = 0;
	directoryCount = 0;
	filePaths: Array<string> = [];
	restoreCommitId: string | null | undefined;
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
		if (request.sql === "SELECT commit_id FROM lix_restore($1)") {
			return {
				columns: ["commit_id"],
				rows: [
					[
						this.restoreCommitId === null
							? { kind: "null" as const }
							: {
									kind: "text" as const,
									value: this.restoreCommitId ?? "new-restore-commit",
								},
					],
				],
				rowsAffected: 1,
				notices: [],
				commit: null,
			};
		}
		if (request.sql === "SELECT commit_id FROM lix_create_checkpoint()") {
			this.commit += 1;
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: `commit-${this.commit}` }]],
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (request.sql.includes("lix_active_branch_commit_id")) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: `commit-${this.commit}` }]],
				rowsAffected: 0,
				notices: [],
				commit: null,
			};
		}
		if (request.sql.startsWith("INSERT INTO lix_file (path, content")) {
			const path = request.params?.[0];
			if (path?.kind !== "text") throw new Error("missing path");
			const param = request.params?.[1];
			const bytes =
				param?.kind === "text"
					? new TextEncoder().encode(param.value)
					: param?.kind === "blob"
						? new Uint8Array(Buffer.from(param.base64, "base64"))
						: new Uint8Array();
			this.stored.set(path.value, bytes);
			return {
				columns: ["id", "path"],
				rows: [
					[
						{
							kind: "text" as const,
							value: "00000000-0000-4000-8000-00000000000f",
						},
						path,
					],
				],
				rowsAffected: 1,
				notices: [],
				commit: null,
			};
		}
		if (request.sql.startsWith("SELECT id, diff_type, from_path, to_path")) {
			if (this.readFailure) throw this.readFailure;
			// The span's two sides are what the last transaction started from
			// and what it left behind.
			const wanted = (request.params ?? [])
				.slice(2)
				.flatMap((param) => (param.kind === "text" ? [param.value] : []));
			const paths = [
				...new Set([...this.previousStored.keys(), ...this.stored.keys()]),
			].filter((path) => wanted.length === 0 || wanted.includes(path));
			const blob = (held: string | Uint8Array | undefined) =>
				held === undefined
					? { kind: "null" as const }
					: {
							kind: "blob" as const,
							base64: Buffer.from(
								typeof held === "string"
									? new TextEncoder().encode(held)
									: held,
							).toString("base64"),
						};
			const rows = paths.flatMap((path, index) => {
				const before = this.previousStored.get(path);
				const after = this.stored.get(path);
				const same =
					before !== undefined &&
					after !== undefined &&
					blob(before).base64 === blob(after).base64;
				if (same) return [];
				return [
					[
						{
							kind: "text" as const,
							value: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
						},
						{
							kind: "text" as const,
							value:
								before === undefined
									? "added"
									: after === undefined
										? "removed"
										: "modified",
						},
						before === undefined
							? { kind: "null" as const }
							: { kind: "text" as const, value: path },
						after === undefined
							? { kind: "null" as const }
							: { kind: "text" as const, value: path },
						blob(before),
						blob(after),
					],
				];
			});
			return {
				columns: [
					"id",
					"diff_type",
					"from_path",
					"to_path",
					"from_content",
					"to_content",
				],
				rows,
				rowsAffected: 0,
				notices: [],
				commit: null,
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
				commit: null,
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
				commit: null,
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
				commit: null,
			};
		}
		return {
			columns: [],
			rows: [],
			rowsAffected: 1,
			notices: [],
			commit: null,
		};
	}

	/** What the last transaction started from, for the change query. */
	previousStored = new Map<string, string | Uint8Array>();

	async transaction<T>(
		lixId: string,
		branchId: string,
		run: (tx: TransactionClient) => Promise<T>,
	): Promise<{ value: T; commit: { before: string; after: string } | null }> {
		this.batches += 1;
		this.previousStored = new Map(this.stored);
		const value = await run({
			execute: (request) => this.execute(lixId, branchId, request),
		});
		return { value, commit: { before: "commit-0", after: "commit-1" } };
	}

	async executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	) {
		this.batches += 1;
		return {
			commit: { before: "commit-0", after: "commit-1" },
			results: (
				await Promise.all(
					request.statements.map((statement) =>
						this.execute(lixId, branchId, statement),
					),
				)
			).map(({ columns, rows, rowsAffected, notices }) => ({
				columns,
				rows,
				rowsAffected,
				notices,
			})),
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
		commitId: "new-restore-commit",
	});
	assert.deepEqual(runtime.calls, [
		{
			lixId: LIX_ID,
			branchId: "draft",
			sql: "SELECT commit_id FROM lix_restore($1)",
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

void test("restore returns the newly created commit rather than the source", async () => {
	const runtime = new FakeRuntime();
	runtime.restoreCommitId = "unexpected-commit";
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID, "draft");

	const restored = await service.restore(opened.context, "commit-target");
	assert.equal(restored.commitId, "unexpected-commit");
});

void test("restore accepts an unchanged-state NULL receipt", async () => {
	const runtime = new FakeRuntime();
	runtime.restoreCommitId = null;
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID, "draft");
	assert.equal(
		(await service.restore(opened.context, "commit-target")).commitId,
		null,
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
			commit: null,
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

void test("the changes of a write come from its receipt, both sides included", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", "# Notes\n");

	const written = await service.writeFiles(opened.context, {
		originKey: "mcp:test",
		files: [
			{ path: "/notes.md", content: "# Notes\n\nAnd more.\n" },
			{ path: "/new.md", content: "# New\n" },
			{ path: "/third.md", content: "# Third\n" },
		],
	});
	assert.deepEqual(written.commit, { before: "commit-0", after: "commit-1" });

	// The write carries no bytes of its own: the span is asked what changed,
	// and only about the files the caller will show.
	const changes = await service.fileChanges(opened.context, written.commit!, [
		"/notes.md",
		"/new.md",
	]);
	assert.deepEqual(changes, [
		{
			id: "00000000-0000-4000-8000-000000000000",
			path: "/notes.md",
			kind: "modified",
			before: new TextEncoder().encode("# Notes\n"),
			after: new TextEncoder().encode("# Notes\n\nAnd more.\n"),
		},
		{
			id: "00000000-0000-4000-8000-000000000001",
			path: "/new.md",
			kind: "added",
			after: new TextEncoder().encode("# New\n"),
		},
	]);
	assert.equal(runtime.reads, 0);
	assert.equal(
		runtime.calls.some((call) => call.sql?.includes("OLD.content")),
		false,
	);
	assert.equal(
		runtime.calls.filter((call) =>
			call.sql?.startsWith("SELECT id, diff_type, from_path, to_path"),
		).length,
		1,
	);
});

void test("a file that was empty is not a file that did not exist", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/empty.md", "");
	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [
			{ path: "/empty.md", content: "changed" },
			{ path: "/new.md", content: "" },
		],
	});

	const changes = await service.fileChanges(opened.context, written.commit!);
	const byPath = new Map(changes.map((change) => [change.path, change]));
	// Zero bytes on the before side; no before side at all.
	assert.deepEqual(byPath.get("/empty.md")?.before, new Uint8Array());
	assert.equal(byPath.get("/empty.md")?.kind, "modified");
	assert.equal(byPath.get("/new.md")?.before, undefined);
	assert.equal(byPath.get("/new.md")?.kind, "added");
	assert.deepEqual(byPath.get("/new.md")?.after, new Uint8Array());
});

void test("bytes that are not text still say the file existed", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", new Uint8Array([0xff, 0xfe, 0x00]));

	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [{ path: "/notes.md", content: "# Notes\n" }],
	});
	const [change] = await service.fileChanges(opened.context, written.commit!);
	assert.deepEqual(change?.before, new Uint8Array([0xff, 0xfe, 0x00]));
	assert.equal(change?.kind, "modified");
});

void test("the receipt does not follow a head that moved afterwards", async () => {
	class AdvancedHeadRuntime extends FakeRuntime {
		override async transaction<T>(
			lixId: string,
			branchId: string,
			run: (tx: TransactionClient) => Promise<T>,
		) {
			const result = await super.transaction(lixId, branchId, run);
			this.commit = 99;
			return result;
		}
	}
	const runtime = new AdvancedHeadRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [{ path: "/new.md", content: "" }],
	});
	assert.equal(written.commitId, "commit-1");
	assert.deepEqual(written.commit, { before: "commit-0", after: "commit-1" });
});

void test("a change row Lix cannot vouch for is refused, not rendered", async () => {
	class BrokenChangesRuntime extends FakeRuntime {
		override async execute(
			lixId: string,
			branchId: string,
			request: ExecuteRequest,
		) {
			const result = await super.execute(lixId, branchId, request);
			if (request.sql.startsWith("SELECT id, diff_type"))
				result.columns = ["id", "diff_type"];
			return result;
		}
	}
	const runtime = new BrokenChangesRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [{ path: "/new.md", content: "saved" }],
	});
	// The write is already saved; only the question about it fails.
	assert.equal(written.commitId, "commit-1");
	await assert.rejects(
		service.fileChanges(opened.context, written.commit!),
		(error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "upstream_error",
	);
});

void test("a file whose path changed across the span is a move", async () => {
	class RenamedRuntime extends FakeRuntime {
		override async execute(
			lixId: string,
			branchId: string,
			request: ExecuteRequest,
		) {
			const result = await super.execute(lixId, branchId, request);
			if (request.sql.startsWith("SELECT id, diff_type")) {
				const text = (value: string) => ({ kind: "text" as const, value });
				const blob = (value: string) => ({
					kind: "blob" as const,
					base64: Buffer.from(value, "utf8").toString("base64"),
				});
				result.rows = [
					[
						text("00000000-0000-4000-8000-000000000000"),
						text("modified"),
						text("/old/notes.md"),
						text("/notes.md"),
						blob("# Notes\n"),
						blob("# Notes\n"),
					],
				];
			}
			return result;
		}
	}
	const service = new LixService(new RenamedRuntime());
	const opened = await service.openLix("@acme/company");
	const changes = await service.fileChanges(opened.context, {
		before: "commit-0",
		after: "commit-1",
	});
	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.path, "/notes.md");
	assert.equal(changes[0]!.movedFrom, "/old/notes.md");
	assert.equal(changes[0]!.kind, "modified");
	// A moved file links where it is now; a removed one links the repository.
	const urls = await service.changeUrls(opened.context, [
		changes[0]!,
		{
			id: "00000000-0000-4000-8000-000000000001",
			path: "/gone.md",
			kind: "removed",
		},
	]);
	assert.equal(urls.repository, "https://lixray.com/@acme/company");
	assert.match(
		urls.files[0]!,
		/^https:\/\/lixray\.com\/@acme\/company\/file\/.*\/notes\.md$/,
	);
	assert.equal(urls.files[1], urls.repository);
});

void test("a diff ref resolves to a commit, or is refused with the reason", async () => {
	class RefRuntime extends FakeRuntime {
		override async execute(
			lixId: string,
			branchId: string,
			request: ExecuteRequest,
		) {
			const text = (value: string) => ({ kind: "text" as const, value });
			const answer = (column: string, values: string[]) => ({
				columns: [column],
				rows: values.map((value) => [text(value)]),
				rowsAffected: 0,
				notices: [],
				commit: null,
			});
			const id = request.params?.[0];
			const given = id?.kind === "text" ? id.value : "";
			if (
				request.sql.startsWith(
					"SELECT commit_id FROM lix_log() WHERE is_checkpoint",
				)
			)
				return answer("commit_id", this.checkpoints.slice(0, 1));
			if (
				request.sql ===
				"SELECT id FROM lix_commit WHERE id = $1 AND is_checkpoint LIMIT 1"
			)
				return answer("id", this.checkpoints.includes(given) ? [given] : []);
			if (request.sql === "SELECT id FROM lix_commit WHERE id = $1 LIMIT 1")
				return answer("id", given.startsWith("commit-") ? [given] : []);
			if (
				request.sql === "SELECT commit_id FROM lix_branch WHERE id = $1 LIMIT 1"
			)
				return answer("commit_id", given === "draft" ? ["commit-7"] : []);
			return super.execute(lixId, branchId, request);
		}
		checkpoints = ["commit-3"];
	}
	const runtime = new RefRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	const resolve = (ref: Parameters<LixService["resolveDiffRef"]>[1]) =>
		service.resolveDiffRef(opened.context, ref);
	assert.equal(await resolve("working"), "commit-0");
	assert.equal(await resolve("latest_checkpoint"), "commit-3");
	assert.equal(await resolve({ checkpoint_id: "commit-3" }), "commit-3");
	assert.equal(await resolve({ commit_id: "commit-9" }), "commit-9");
	assert.equal(await resolve({ branch_id: "draft" }), "commit-7");
	const refused = async (
		ref: Parameters<LixService["resolveDiffRef"]>[1],
		message: RegExp,
	) =>
		assert.rejects(resolve(ref), (error: unknown) => {
			const failure = error as {
				code?: unknown;
				message: string;
				hint?: string;
			};
			assert.equal(failure.code, "not_found");
			assert.match(failure.message, message);
			assert.match(failure.hint ?? "", /latest_checkpoint/);
			return true;
		});
	await refused({ checkpoint_id: "commit-9" }, /No checkpoint commit-9/);
	await refused({ commit_id: "nope" }, /No commit nope/);
	await refused({ branch_id: "main" }, /No branch main/);
	runtime.checkpoints = [];
	await refused("latest_checkpoint", /no checkpoint yet/);
});

void test("readFiles takes bytes and the read commit through the same transaction", async () => {
	class SnapshotRuntime extends FakeRuntime {
		inside = false;
		override async transaction<T>(
			lixId: string,
			branchId: string,
			run: (tx: TransactionClient) => Promise<T>,
		) {
			this.inside = true;
			try {
				return await super.transaction(lixId, branchId, run);
			} finally {
				this.inside = false;
			}
		}
		override async execute(
			lixId: string,
			branchId: string,
			request: ExecuteRequest,
		) {
			if (request.sql.startsWith("SELECT id, path, content"))
				assert.equal(this.inside, true);
			return super.execute(lixId, branchId, request);
		}
	}
	const runtime = new SnapshotRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	runtime.stored.set("/notes.md", "snapshot");
	const reads = await service.readFiles(opened.context, ["/notes.md"]);
	assert.equal(reads.files[0]?.content, "snapshot");
	assert.equal(reads.commitId, "commit-0");
});

for (const concurrentPath of ["/target.md", "/unrelated.md"]) {
	void test(`a retry revalidates the whole write batch after ${concurrentPath} changes`, async () => {
		class ConcurrentRuntime extends FakeRuntime {
			attempts = 0;
			override async transaction<T>(
				lixId: string,
				branchId: string,
				run: (tx: TransactionClient) => Promise<T>,
			) {
				const original = new Map(this.stored);
				const execute = (request: ExecuteRequest) =>
					this.execute(lixId, branchId, request);
				this.attempts++;
				await run({ execute });
				// A definite engine conflict discards the first attempt before retry.
				this.stored.clear();
				for (const [path, bytes] of original) this.stored.set(path, bytes);
				this.stored.set(concurrentPath, "concurrent edit");
				this.commit = 2;
				this.attempts++;
				const value = await run({ execute });
				return { value, commit: { before: "commit-2", after: "commit-3" } };
			}
			override async execute(
				lixId: string,
				branchId: string,
				request: ExecuteRequest,
			) {
				if (request.sql.startsWith("SELECT from_path, to_path"))
					return {
						columns: ["from_path", "to_path"],
						rows: [
							[
								{ kind: "text" as const, value: concurrentPath },
								{ kind: "text" as const, value: concurrentPath },
							],
						],
						rowsAffected: 0,
						notices: [],
						commit: null,
					};
				return super.execute(lixId, branchId, request);
			}
		}
		const runtime = new ConcurrentRuntime();
		const service = new LixService(runtime);
		const opened = await service.openLix("@acme/company");
		runtime.stored.set("/target.md", "original");
		const write = service.writeFiles(opened.context, {
			originKey: "test",
			lastSeenCommitId: "commit-0",
			files: [
				{ path: "/target.md", content: "ours" },
				{ path: "/second.md", content: "second" },
			],
		});
		if (concurrentPath === "/target.md") {
			await assert.rejects(write, { code: "conflict" });
			assert.equal(runtime.stored.get("/target.md"), "concurrent edit");
			assert.equal(runtime.stored.has("/second.md"), false);
		} else {
			assert.equal((await write).commitId, "commit-3");
			assert.equal(
				new TextDecoder().decode(
					runtime.stored.get("/target.md") as Uint8Array,
				),
				"ours",
			);
			assert.equal(runtime.stored.get("/unrelated.md"), "concurrent edit");
		}
		assert.equal(runtime.attempts, 2);
	});
}

void test("a missing receipt after commit is still a saved response", async () => {
	class MissingReceiptRuntime extends FakeRuntime {
		override async transaction<T>(
			lixId: string,
			branchId: string,
			run: (tx: TransactionClient) => Promise<T>,
		) {
			const result = await super.transaction(lixId, branchId, run);
			return { value: result.value, commit: null };
		}
	}
	const runtime = new MissingReceiptRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [{ path: "/saved.md", content: "saved" }],
	});
	assert.equal(written.commit, null);
	assert.equal(written.commitId, undefined);
	assert.match(
		written.warning ?? "",
		/Files saved; commit receipt unavailable/,
	);
	assert.equal(written.files.length, 1);
	assert.equal(runtime.batches, 1);
});

void test("metadata-only validation never requests file bytes", async () => {
	class MetadataRuntime extends FakeRuntime {
		override async execute(
			lixId: string,
			branchId: string,
			request: ExecuteRequest,
		) {
			if (
				request.sql.startsWith("SELECT id, path FROM lix_file WHERE") ||
				request.sql.startsWith("UPDATE lix_file SET lixcol_metadata")
			) {
				assert.doesNotMatch(request.sql, /\bcontent\b/);
				return {
					columns: ["id", "path"],
					rows: [
						[
							{
								kind: "text" as const,
								value: "00000000-0000-4000-8000-00000000000f",
							},
							{ kind: "text" as const, value: "/asset.bin" },
						],
					],
					rowsAffected: 1,
					notices: [],
					commit: null,
				};
			}
			return super.execute(lixId, branchId, request);
		}
	}
	const runtime = new MetadataRuntime();
	const service = new LixService(runtime);
	const opened = await service.openLix("@acme/company");
	runtime.readFailure = new Error("blob unavailable");
	const written = await service.writeFiles(opened.context, {
		originKey: "test",
		files: [{ path: "/asset.bin", lixcol_metadata: { label: "asset" } }],
	});
	assert.equal(written.files[0]?.path, "/asset.bin");
	assert.equal(runtime.reads, 0);
});

for (const failCheckpoint of [false, true]) {
	void test(`optional checkpoint keeps the saved write receipt when checkpoint ${failCheckpoint ? "fails" : "advances the head"}`, async () => {
		class CheckpointRuntime extends FakeRuntime {
			override async execute(
				lixId: string,
				branchId: string,
				request: ExecuteRequest,
			) {
				if (request.sql === "SELECT commit_id FROM lix_create_checkpoint()") {
					if (failCheckpoint) throw new Error("checkpoint failed");
					this.commit = 1;
				}
				return super.execute(lixId, branchId, request);
			}
		}
		const runtime = new CheckpointRuntime();
		const service = new LixService(runtime);
		const opened = await service.openLix("@acme/company");
		const written = await service.writeFiles(opened.context, {
			originKey: "test",
			checkpoint: true,
			files: [{ path: "/saved.md", content: "saved" }],
		});
		assert.deepEqual(written.commit, { before: "commit-0", after: "commit-1" });
		assert.equal(written.commitId, "commit-1");
		assert.equal(runtime.batches, 1);
		if (failCheckpoint) {
			assert.equal(written.checkpointCommitId, undefined);
			assert.match(
				written.warning ?? "",
				/Files saved; checkpoint unavailable/,
			);
		} else {
			assert.equal(written.checkpointCommitId, "commit-2");
		}
	});
}
