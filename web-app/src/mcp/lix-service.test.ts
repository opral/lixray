import assert from "node:assert/strict";
import test from "node:test";
import {
	LixService,
	isLixError,
	type BindSessionInput,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type LixRuntimeClient,
} from "./lix-service.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

class FakeRuntime implements LixRuntimeClient {
	branch = "main";
	commit = 0;
	readonly opened = new Set<string>();
	readonly binds: Array<BindSessionInput> = [];
	readonly calls: Array<{ lixId: string; branchId: string; sql?: string }> = [];

	hasOpenRuntime(lixId: string) {
		return this.opened.has(lixId);
	}

	bindSession(input: BindSessionInput) {
		this.binds.push(input);
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

	async switchBranch(lixId: string, branchId: string) {
		this.admit(lixId);
		this.branch = branchId;
		return { branchId };
	}

	async execute(lixId: string, branchId: string, request: ExecuteRequest) {
		this.admit(lixId);
		this.calls.push({ lixId, branchId, sql: request.sql });
		if (request.sql.includes("lix_active_branch_commit_id")) {
			return {
				columns: ["commit_id"],
				rows: [[{ kind: "text" as const, value: `commit-${this.commit}` }]],
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
	async createCheckpoint() {
		this.commit += 1;
		return { commitId: `commit-${this.commit}` };
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
	assert.equal(opened.branchId, "main");
	assert.match(opened.context, /^[^.]+\.[^.]+$/);
	assert.ok(Date.parse(opened.contextExpiresAt) > Date.now());

	const result = await service.execute(opened.context, { sql: "SELECT 1" });
	assert.equal(result.context, opened.context);
	assert.equal(runtime.calls.at(-1)?.branchId, "main");
	assert.deepEqual(runtime.binds, []);
});

void test("signed-context create on a cache-hit runtime binds once; cache-admit does not", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user-123", clientId: "client" },
	});

	await runtime.activeBranchId(LIX_ID);
	assert.equal(runtime.hasOpenRuntime(LIX_ID), true);
	assert.deepEqual(runtime.binds, []);

	const opened = await service.openLix(LIX_ID);
	assert.equal(opened.lixId, LIX_ID);
	assert.deepEqual(runtime.binds, [
		{
			lixId: LIX_ID,
			branchId: "main",
			accountId: "user-123",
			organizationId: "n",
		},
	]);

	await service.openLix(LIX_ID);
	assert.equal(runtime.binds.length, 2);
	assert.deepEqual(
		new Set(runtime.binds.map((bind) => bind.accountId)),
		new Set(["user-123"]),
	);
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
		(error: unknown) =>
			isLixError(error) &&
			error.code === "context_expired" &&
			error.hint?.includes("open_lix") === true &&
			JSON.stringify(error.details).includes(LIX_ID),
	);
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

void test("contexts are bound to the principal and reject tampering", async () => {
	const runtime = new FakeRuntime();
	const service = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "user", clientId: "client" },
	});
	const opened = await service.openLix(LIX_ID);
	const tampered = `${opened.context.slice(0, -1)}x`;
	await assert.rejects(
		service.execute(tampered, { sql: "SELECT 1" }),
		(error: unknown) => isLixError(error) && error.code === "invalid_context",
	);

	const otherPrincipal = new LixService(runtime, {
		contextSigningKey: "test-key",
		principal: { userId: "other-user", clientId: "client" },
	});
	await assert.rejects(
		otherPrincipal.execute(opened.context, { sql: "SELECT 1" }),
		(error: unknown) => isLixError(error) && error.code === "invalid_context",
	);
});
