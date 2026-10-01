import assert from "node:assert/strict";
import test from "node:test";
import {
	openLix,
	type ExecuteOptions,
	type Lix,
	type SqlParam,
} from "@lix-js/sdk";
import {
	contentRevision,
	createWorkingSetRemote,
} from "./prototype-working-set-remote.ts";
import type {
	PrototypePublishRequest,
	PrototypeWorkingSetScope,
} from "./prototype-working-set.ts";

async function insertTextFile(lix: Lix, path: string, content: string) {
	const result = await lix.execute(
		"INSERT INTO lix_file(path, content) VALUES ($1, CAST($2 AS BYTEA)) RETURNING id",
		[path, content],
	);
	const id = result.rows[0]?.id;
	assert.equal(typeof id, "string");
	return id as string;
}

async function readTextFile(lix: Lix, id: string): Promise<string> {
	const result = await lix.execute(
		"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
		[id],
	);
	assert.equal(result.rows.length, 1);
	assert.equal(typeof result.rows[0]?.content, "string");
	return result.rows[0]!.content as string;
}

function scopeFor(
	accountId: string,
	branchId: string,
	fileId: string,
): PrototypeWorkingSetScope {
	return {
		accountId,
		repositoryId: "repository-test",
		branchId,
		fileId,
	};
}

function publishRequest(
	operationId: string,
	baseContent: string,
	content: string,
): Promise<PrototypePublishRequest> {
	return contentRevision(baseContent).then((baseRevision) => ({
		operationId,
		baseRevision,
		baseContent,
		content,
	}));
}

void test("remote adapter pins reads and writes to its requested branch", async () => {
	const authority = await openLix();
	const mainBranchId = await authority.activeBranchId();
	const accountId = await authority.activeAccountId();
	let remote: Awaited<ReturnType<typeof createWorkingSetRemote>> | undefined;
	try {
		const fileId = await insertTextFile(authority, "/branch-fence.txt", "base");
		const draft = await authority.createBranch({
			name: "working-set adapter test",
		});
		await authority.execute(
			"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2",
			["main-only", fileId],
		);

		const scope = scopeFor(accountId, draft.id, fileId);
		remote = await createWorkingSetRemote(authority, scope);
		assert.deepEqual(await remote.read(scope), {
			content: "base",
			revision: await contentRevision("base"),
		});

		const result = await remote.compareAndSet(
			scope,
			await publishRequest("draft-edit", "base", "draft-only"),
		);
		assert.deepEqual(result, {
			status: "committed",
			revision: await contentRevision("draft-only"),
		});
		assert.equal(await readTextFile(authority, fileId), "main-only");
		assert.equal(await authority.activeBranchId(), mainBranchId);

		const requestedBranchId = scope.branchId;
		scope.branchId = mainBranchId;
		await assert.rejects(remote.read(scope), /scope mismatch/);
		scope.branchId = requestedBranchId;

		const mismatchedScope = { ...scope, branchId: mainBranchId };
		await assert.rejects(remote.read(mismatchedScope), /scope mismatch/);
		await assert.rejects(
			remote.compareAndSet(
				mismatchedScope,
				await publishRequest("wrong-branch", "base", "must-not-write"),
			),
			/scope mismatch/,
		);
	} finally {
		await remote?.close();
		await authority.close();
	}
});

void test("remote adapter rejects and closes a session for another account", async () => {
	const authority = await openLix();
	let mismatchedSessionClosed = false;
	try {
		const actualAccountId = await authority.activeAccountId();
		const branchId = await authority.activeBranchId();
		const authorityWithTrackedSession = {
			openAnotherSession: async ({
				branchId: requestedBranchId,
			}: {
				branchId: string;
			}) => {
				const session = await authority.openAnotherSession({
					branchId: requestedBranchId,
				});
				return {
					activeAccountId: () => session.activeAccountId(),
					close: async () => {
						mismatchedSessionClosed = true;
						await session.close();
					},
				};
			},
		} as unknown as Lix;

		await assert.rejects(
			createWorkingSetRemote(
				authorityWithTrackedSession,
				scopeFor(`${actualAccountId}-wrong`, branchId, "file-test"),
			),
			/authority account mismatch/,
		);
		assert.equal(mismatchedSessionClosed, true);
	} finally {
		await authority.close();
	}
});

void test("content CAS commits matching bytes and returns the actual conflicting text", async () => {
	const authority = await openLix();
	let remote: Awaited<ReturnType<typeof createWorkingSetRemote>> | undefined;
	try {
		const branchId = await authority.activeBranchId();
		const accountId = await authority.activeAccountId();
		const fileId = await insertTextFile(authority, "/content-cas.txt", "base");
		const scope = scopeFor(accountId, branchId, fileId);
		remote = await createWorkingSetRemote(authority, scope);

		const base = await remote.read(scope);
		assert.equal(base.revision, await contentRevision("base"));
		await authority.execute(
			"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2",
			["server edit", fileId],
		);

		const conflict = await remote.compareAndSet(
			scope,
			await publishRequest("stale-edit", base.content, "local edit"),
		);
		assert.deepEqual(conflict, {
			status: "conflict",
			actual: {
				content: "server edit",
				revision: await contentRevision("server edit"),
			},
		});
		assert.equal(await readTextFile(authority, fileId), "server edit");

		const current = await remote.read(scope);
		const committed = await remote.compareAndSet(
			scope,
			await publishRequest("fresh-edit", current.content, "new local edit"),
		);
		assert.deepEqual(committed, {
			status: "committed",
			revision: await contentRevision("new local edit"),
		});
		assert.equal(await readTextFile(authority, fileId), "new local edit");
	} finally {
		await remote?.close();
		await authority.close();
	}
});

void test("a lost acknowledgement replays the same receipt without a second SQL mutation", async () => {
	const authority = await openLix();
	let remote: Awaited<ReturnType<typeof createWorkingSetRemote>> | undefined;
	try {
		const branchId = await authority.activeBranchId();
		const accountId = await authority.activeAccountId();
		const fileId = await insertTextFile(authority, "/lost-ack.txt", "base");
		const scope = scopeFor(accountId, branchId, fileId);
		const receipts = new Map<string, { rows: unknown[] }>();
		const idempotencyKeys: string[] = [];
		let sqlMutationCount = 0;
		let loseAcknowledgement = true;

		// Run the adapter's real SQL against a Node SDK memory authority. This
		// transport shim models the server's durable receipt lookup: receipt replay
		// happens before SQL is re-executed after an accepted mutation loses its ACK.
		const authorityWithReceipts = {
			openAnotherSession: async ({
				branchId: sessionBranchId,
			}: {
				branchId: string;
			}) => {
				const session = await authority.openAnotherSession({
					branchId: sessionBranchId,
				});
				return {
					activeAccountId: () => session.activeAccountId(),
					execute: async (
						sql: string,
						params?: SqlParam[],
						options?: ExecuteOptions,
					) => {
						const key = options?.idempotencyKey;
						if (key) {
							idempotencyKeys.push(key);
							const previous = receipts.get(key);
							if (previous) return previous;
						}
						const result = await session.execute(sql, params, options);
						if (/^\s*UPDATE\s+lix_file/i.test(sql)) {
							sqlMutationCount += 1;
						}
						const receipt = { rows: result.rows };
						if (key) receipts.set(key, receipt);
						if (key === "op-lost-ack" && loseAcknowledgement) {
							loseAcknowledgement = false;
							throw new TypeError("connection closed after accepted mutation");
						}
						return receipt;
					},
					close: () => session.close(),
				};
			},
		} as unknown as Lix;
		remote = await createWorkingSetRemote(authorityWithReceipts, scope);
		const request = await publishRequest(
			"op-lost-ack",
			"base",
			"accepted once",
		);

		await assert.rejects(
			remote.compareAndSet(scope, request),
			/connection closed/,
		);
		assert.equal(await readTextFile(authority, fileId), "accepted once");

		assert.deepEqual(await remote.compareAndSet(scope, request), {
			status: "committed",
			revision: await contentRevision("accepted once"),
		});
		assert.deepEqual(idempotencyKeys, ["op-lost-ack", "op-lost-ack"]);
		assert.equal(sqlMutationCount, 1);
		assert.equal(await readTextFile(authority, fileId), "accepted once");
	} finally {
		await remote?.close();
		await authority.close();
	}
});
