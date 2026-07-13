import assert from "node:assert/strict";
import test from "node:test";
import {
	createMemoryWorkspaceBackend,
	decodeWireValue,
	encodeWireValue,
	type MemoryLixBinding,
} from "./memory-backend.ts";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";

void test("wire values round-trip through native Lix values", () => {
	const wireValues = [
		{ kind: "null", value: null },
		{ kind: "bool", value: true },
		{ kind: "int", value: 42 },
		{ kind: "float", value: 1.25 },
		{ kind: "text", value: "hello" },
		{ kind: "blob", base64: "AQID" },
		{ kind: "json", value: { ok: true } },
	] as const;
	for (const wire of wireValues) {
		assert.deepEqual(encodeWireValue(decodeWireValue(wire)), wire);
	}
});

void test("workspace initialization is lazy, shared, and isolated by id", async () => {
	let opens = 0;
	const backend = createMemoryWorkspaceBackend(async () => {
		opens += 1;
		await Promise.resolve();
		return fakeBinding();
	});
	assert.equal(opens, 0);

	await Promise.all([
		backend.fetch(WORKSPACE_A, workspaceRequest("/branches")),
		backend.fetch(WORKSPACE_A, workspaceRequest("/branches")),
	]);
	assert.equal(opens, 1);
	assert.equal(backend.workspaceCount(), 1);

	await backend.fetch(WORKSPACE_B, workspaceRequest("/branches"));
	assert.equal(opens, 2);
	assert.equal(backend.workspaceCount(), 2);
});

void test("finite operations serialize and select their requested branch", async () => {
	let activeExecutions = 0;
	let maximumExecutions = 0;
	const selected: string[] = [];
	const binding = fakeBinding({
		switchBranch: async ({ branchId }: { branchId: string }) => {
			selected.push(branchId);
			return { branchId };
		},
		execute: async () => {
			activeExecutions += 1;
			maximumExecutions = Math.max(maximumExecutions, activeExecutions);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeExecutions -= 1;
			return emptyResult();
		},
	});
	const backend = createMemoryWorkspaceBackend(async () => binding);
	const branches = [BRANCH, WORKSPACE_B];

	const responses = await Promise.all(
		branches.map((branchId) =>
			backend.fetch(
				WORKSPACE_A,
				workspaceRequest("/execute", {
					branchId,
					sql: "SELECT 1",
				}),
			),
		),
	);
	assert.deepEqual(
		responses.map((response) => response.status),
		[200, 200],
	);
	assert.equal(maximumExecutions, 1);
	assert.deepEqual(selected, branches);
});

void test("filesystem conflicts roll back without applying a mutation", async () => {
	let rollbacks = 0;
	let commits = 0;
	const binding = fakeBinding({
		beginTransaction: async () => ({
			execute: async () => emptyResult(),
			commit: async () => {
				commits += 1;
			},
			rollback: async () => {
				rollbacks += 1;
			},
		}),
	});
	const backend = createMemoryWorkspaceBackend(async () => binding);
	const response = await backend.fetch(
		WORKSPACE_A,
		workspaceRequest("/filesystem/mutate", {
			branchId: BRANCH,
			kind: "file",
			path: "/missing.md",
			expectedRevision: "revision-1",
			mutation: { type: "delete" },
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { outcome: "conflict" });
	assert.equal(rollbacks, 1);
	assert.equal(commits, 0);
});

void test("Lix errors preserve envelopes and HTTP status mapping", async () => {
	const binding = fakeBinding({
		switchBranch: async () => {
			throw Object.assign(new Error("branch missing"), {
				code: "LIX_BRANCH_NOT_FOUND",
				hint: "Choose an existing branch.",
				details: { branch_id: BRANCH },
			});
		},
	});
	const backend = createMemoryWorkspaceBackend(async () => binding);
	const response = await backend.fetch(
		WORKSPACE_A,
		workspaceRequest("/execute", { branchId: BRANCH, sql: "SELECT 1" }),
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), {
		error: {
			code: "LIX_BRANCH_NOT_FOUND",
			message: "branch missing",
			hint: "Choose an existing branch.",
			details: { branch_id: BRANCH },
		},
	});
});

void test("multiplex observations retain subscription ids and SSE framing", async () => {
	let observation = 0;
	const binding = fakeBinding({
		observe: async () => {
			const sequence = ++observation;
			let emitted = false;
			return {
				close: () => undefined,
				next: async () => {
					if (emitted) return null;
					emitted = true;
					return {
						sequence,
						mutationSequence: sequence + 10,
						rows: {
							columns: ["value"],
							rows: [[{ kind: "integer", value: sequence }]],
							rowsAffected: 0,
							notices: [],
						},
					};
				},
			};
		},
	});
	const backend = createMemoryWorkspaceBackend(async () => binding);
	const response = await backend.fetch(
		WORKSPACE_A,
		workspaceRequest("/observe/multiplex", {
			branchId: BRANCH,
			subscriptions: [
				{ id: "files", sql: "SELECT * FROM lix_file", params: [] },
				{ id: "dirs", sql: "SELECT * FROM lix_directory", params: [] },
			],
		}),
	);
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	assert.match(body, /event: next\ndata: .*"subscriptionId":"files"/);
	assert.match(body, /event: next\ndata: .*"subscriptionId":"dirs"/);
	assert.match(body, /"mutationSequence":1[12]/);
});

function fakeBinding(
	overrides: Record<string, unknown> = {},
): MemoryLixBinding {
	return {
		execute: async (sql: string) =>
			sql.includes("FROM lix_branch") ? branchResult() : emptyResult(),
		observe: async () => ({ close: () => undefined, next: async () => null }),
		beginTransaction: async () => ({
			execute: async () => emptyResult(),
			commit: async () => undefined,
			rollback: async () => undefined,
		}),
		createBranch: async ({ id, name }) => ({
			id: id ?? BRANCH,
			name,
			hidden: false,
			commitId: "commit-1",
		}),
		switchBranch: async ({ branchId }) => ({ branchId }),
		close: async () => undefined,
		...overrides,
	} as MemoryLixBinding;
}

function branchResult() {
	return {
		columns: ["id", "name", "hidden", "commit_id"],
		rows: [
			[
				{ kind: "text", value: BRANCH },
				{ kind: "text", value: "main" },
				{ kind: "boolean", value: false },
				{ kind: "text", value: "commit-1" },
			],
		],
		rowsAffected: 0,
		notices: [],
	};
}

function emptyResult() {
	return { columns: [], rows: [], rowsAffected: 0, notices: [] };
}

function workspaceRequest(path: string, body?: unknown) {
	return new Request(
		`https://preview.example${path.startsWith("/v1") ? path : `/v1${path}`}`,
		{
			method: body === undefined ? "GET" : "POST",
			headers:
				body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	);
}
