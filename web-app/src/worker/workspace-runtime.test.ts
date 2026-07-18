import assert from "node:assert/strict";
import test from "node:test";
import {
	createMemoryWorkspaceRuntime,
	decodeWireValue,
	encodeWireValue,
	type MemoryLixBinding,
	type ParseSqlScript,
} from "./workspace-runtime.ts";

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
	const runtime = testRuntime(async () => {
		opens += 1;
		await Promise.resolve();
		return fakeBinding();
	});
	assert.equal(opens, 0);

	await Promise.all([
		runtime.fetch(WORKSPACE_A, workspaceRequest("/branches")),
		runtime.fetch(WORKSPACE_A, workspaceRequest("/branches")),
	]);
	assert.equal(opens, 1);
	assert.equal(runtime.workspaceCount(), 1);

	await runtime.fetch(WORKSPACE_B, workspaceRequest("/branches"));
	assert.equal(opens, 2);
	assert.equal(runtime.workspaceCount(), 2);
});

void test("canonical main branch ids work across independent isolates", async () => {
	const first = testRuntime(
		async () => statefulBranchBinding(WORKSPACE_A),
		BRANCH,
	);
	const second = testRuntime(
		async () => statefulBranchBinding(WORKSPACE_B),
		BRANCH,
	);

	const firstResponse = await first.fetch(
		WORKSPACE_A,
		workspaceRequest("/branches"),
	);
	const secondResponse = await second.fetch(
		WORKSPACE_A,
		workspaceRequest("/branches"),
	);
	const firstBody = await firstResponse.json();
	const secondBody = await secondResponse.json();
	const firstMainBranch = mainBranch(firstBody);
	const secondMainBranch = mainBranch(secondBody);

	assert.equal(firstMainBranch.id, BRANCH);
	assert.equal(secondMainBranch.id, BRANCH);
	assert.equal(currentBranchId(firstBody), BRANCH);
	assert.equal(currentBranchId(secondBody), BRANCH);
	const executeResponse = await second.fetch(
		WORKSPACE_A,
		workspaceRequest("/execute", {
			branchId: firstMainBranch.id,
			sql: "SELECT 1",
		}),
	);
	assert.equal(executeResponse.status, 200);
});

void test("branch creation rejects ids outside the MCP UUID contract", async () => {
	let createCalls = 0;
	const runtime = testRuntime(async () =>
		fakeBinding({
			createBranch: async () => {
				createCalls += 1;
				throw new Error("createBranch should not be called");
			},
		}),
	);
	for (const id of ["draft", "99999999-9999-9999-9999-999999999999"]) {
		const response = await runtime.fetch(
			WORKSPACE_A,
			workspaceRequest("/createBranch", {
				branchId: BRANCH,
				id,
				name: "Draft",
			}),
		);

		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: {
				code: "LIX_INVALID_ARGUMENT",
				message: "id must be a UUID",
			},
		});
	}
	assert.equal(createCalls, 0);
});

void test("branch switch validates the target and restores the runtime main branch", async () => {
	let activeBranchId = BRANCH;
	const switched: string[] = [];
	const branches = new Set([BRANCH, WORKSPACE_B]);
	const runtime = testRuntime(async () =>
		fakeBinding({
			activeBranchId: async () => activeBranchId,
			switchBranch: async ({ branchId }: { branchId: string }) => {
				if (!branches.has(branchId)) {
					throw Object.assign(new Error(`branch missing: ${branchId}`), {
						code: "LIX_BRANCH_NOT_FOUND",
					});
				}
				activeBranchId = branchId;
				switched.push(branchId);
				return { branchId };
			},
		}),
	);

	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/switchBranch", { branchId: WORKSPACE_B }),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { branchId: WORKSPACE_B });
	assert.deepEqual(switched, [WORKSPACE_B, BRANCH]);
	assert.equal(activeBranchId, BRANCH);

	const missing = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/switchBranch", { branchId: WORKSPACE_A }),
	);
	assert.equal(missing.status, 404);
	assert.deepEqual(await missing.json(), {
		error: {
			code: "LIX_BRANCH_NOT_FOUND",
			message: `branch missing: ${WORKSPACE_A}`,
		},
	});
	assert.equal(activeBranchId, BRANCH);
});

void test("failed canonical branch initialization closes and evicts the runtime", async () => {
	let opens = 0;
	let closes = 0;
	const runtime = testRuntime(async () => {
		opens += 1;
		if (opens === 1) {
			return fakeBinding({
				activeBranchId: async () => WORKSPACE_A,
				createBranch: async () => {
					throw new Error("canonicalization failed");
				},
				close: async () => {
					closes += 1;
				},
			});
		}
		return statefulBranchBinding(WORKSPACE_B);
	}, BRANCH);

	const failed = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/branches"),
	);
	assert.equal(failed.status, 500);
	assert.equal(closes, 1);
	assert.equal(runtime.workspaceCount(), 0);

	const retried = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/branches"),
	);
	assert.equal(retried.status, 200);
	assert.equal(opens, 2);
	assert.equal(mainBranch(await retried.json()).id, BRANCH);
});

void test("finite operations serialize and select their requested branch", async () => {
	let activeExecutions = 0;
	let maximumExecutions = 0;
	const selected: string[] = [];
	let activeBranchId = BRANCH;
	const binding = fakeBinding({
		activeBranchId: async () => activeBranchId,
		switchBranch: async ({ branchId }: { branchId: string }) => {
			activeBranchId = branchId;
			return { branchId };
		},
		execute: async () => {
			selected.push(activeBranchId);
			activeExecutions += 1;
			maximumExecutions = Math.max(maximumExecutions, activeExecutions);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeExecutions -= 1;
			return emptyResult();
		},
	});
	const runtime = testRuntime(async () => binding);
	const branches = [BRANCH, WORKSPACE_B];

	const responses = await Promise.all(
		branches.map((branchId) =>
			runtime.fetch(
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

void test("execute keeps the single-statement fast path and wraps its result", async () => {
	let directExecutions = 0;
	let transactionStarts = 0;
	const runtime = testRuntime(async () =>
		fakeBinding({
			execute: async () => {
				directExecutions += 1;
				return mutationResult(1);
			},
			beginTransaction: async () => {
				transactionStarts += 1;
				throw new Error("single statement should not open a transaction");
			},
		}),
	);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/execute", { branchId: BRANCH, sql: "SELECT 1" }),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		results: [{ columns: [], rows: [], rowsAffected: 1, notices: [] }],
	});
	assert.equal(directExecutions, 1);
	assert.equal(transactionStarts, 0);
});

void test("executeStatement bypasses script planning and returns a direct result", async () => {
	let directExecutions = 0;
	const runtime = testRuntime(
		async () =>
			fakeBinding({
				execute: async (
					sql: string,
					params: Array<unknown>,
					options: unknown,
				) => {
					directExecutions += 1;
					assert.equal(sql, "SELECT $1 AS value");
					assert.deepEqual(params.map(nativeText), ["visible"]);
					assert.deepEqual(options, { originKey: "remote-client" });
					return {
						columns: ["value"],
						rows: [[{ kind: "text", value: "visible" }]],
						rowsAffected: 0,
						notices: [],
					};
				},
			}),
		BRANCH,
		() => {
			throw new Error("canonical statements must not use script planning");
		},
	);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/executeStatement", {
			branchId: BRANCH,
			sql: "SELECT $1 AS value",
			params: [{ kind: "text", value: "visible" }],
			options: { originKey: "remote-client" },
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		columns: ["value"],
		rows: [[{ kind: "text", value: "visible" }]],
		rowsAffected: 0,
		notices: [],
	});
	assert.equal(directExecutions, 1);
});

void test("execute runs scripts atomically and returns ordered results", async () => {
	const executions: Array<{
		sql: string;
		params: Array<unknown>;
		options: unknown;
	}> = [];
	let commits = 0;
	let rollbacks = 0;
	const binding = fakeBinding({
		beginTransaction: async () => ({
			execute: async (
				sql: string,
				params: Array<unknown>,
				options: unknown,
			) => {
				executions.push({ sql, params, options });
				return sql.startsWith("SELECT")
					? {
							columns: ["value"],
							rows: [[{ kind: "text", value: "visible" }]],
							rowsAffected: 0,
							notices: [],
						}
					: mutationResult(1);
			},
			commit: async () => {
				commits += 1;
			},
			rollback: async () => {
				rollbacks += 1;
			},
		}),
	});
	const runtime = testRuntime(
		async () => binding,
		BRANCH,
		(sql, paramCount) => {
			assert.equal(
				sql,
				"BEGIN; INSERT INTO example VALUES ($1, $2); SELECT value FROM example WHERE id = $3; COMMIT",
			);
			assert.equal(paramCount, 3);
			return {
				statements: [
					{
						sql: "INSERT INTO example VALUES ($1, $2)",
						paramStart: 0,
						paramEnd: 2,
					},
					{
						sql: "SELECT value FROM example WHERE id = $3",
						paramStart: 0,
						paramEnd: 3,
					},
				],
			};
		},
	);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/execute", {
			branchId: BRANCH,
			sql: "BEGIN; INSERT INTO example VALUES ($1, $2); SELECT value FROM example WHERE id = $3; COMMIT",
			params: [
				{ kind: "text", value: "one" },
				{ kind: "text", value: "two" },
				{ kind: "text", value: "three" },
			],
			options: { originKey: "batch-origin" },
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		results: [
			{ columns: [], rows: [], rowsAffected: 1, notices: [] },
			{
				columns: ["value"],
				rows: [[{ kind: "text", value: "visible" }]],
				rowsAffected: 0,
				notices: [],
			},
		],
	});
	assert.equal(commits, 1);
	assert.equal(rollbacks, 0);
	assert.deepEqual(
		executions.map(({ sql, params, options }) => ({
			sql,
			params: params.map(nativeText),
			options,
		})),
		[
			{
				sql: "INSERT INTO example VALUES ($1, $2)",
				params: ["one", "two"],
				options: { originKey: "batch-origin" },
			},
			{
				sql: "SELECT value FROM example WHERE id = $3",
				params: ["one", "two", "three"],
				options: { originKey: "batch-origin" },
			},
		],
	);
});

void test("execute rolls a script back when a later statement fails", async () => {
	let executions = 0;
	let commits = 0;
	let rollbacks = 0;
	const failure = Object.assign(new Error("duplicate key"), {
		code: "LIX_UNIQUE",
	});
	const runtime = testRuntime(
		async () =>
			fakeBinding({
				beginTransaction: async () => ({
					execute: async () => {
						executions += 1;
						if (executions === 2) throw failure;
						return mutationResult(1);
					},
					commit: async () => {
						commits += 1;
					},
					rollback: async () => {
						rollbacks += 1;
					},
				}),
			}),
		BRANCH,
		() => ({
			statements: [
				{
					sql: "INSERT INTO example VALUES (?)",
					paramStart: 0,
					paramEnd: 1,
				},
				{
					sql: "INSERT INTO example VALUES (?)",
					paramStart: 1,
					paramEnd: 2,
				},
			],
		}),
	);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/execute", {
			branchId: BRANCH,
			sql: "INSERT INTO example VALUES (?); INSERT INTO example VALUES (?)",
			params: [
				{ kind: "text", value: "one" },
				{ kind: "text", value: "two" },
			],
		}),
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: { code: "LIX_UNIQUE", message: "duplicate key" },
	});
	assert.equal(executions, 2);
	assert.equal(commits, 0);
	assert.equal(rollbacks, 1);
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
	const runtime = testRuntime(async () => binding);
	const response = await runtime.fetch(
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
		activeBranchId: async () => WORKSPACE_A,
		switchBranch: async () => {
			throw Object.assign(new Error("branch missing"), {
				code: "LIX_BRANCH_NOT_FOUND",
				hint: "Choose an existing branch.",
				details: { branch_id: BRANCH },
			});
		},
	});
	const runtime = testRuntime(async () => binding);
	const response = await runtime.fetch(
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
		execute: async () => {
			const sequence = ++observation;
			return {
				columns: ["value"],
				rows: [[{ kind: "integer", value: sequence }]],
				rowsAffected: 0,
				notices: [],
			};
		},
	});
	const runtime = testRuntime(async () => binding);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/observe/multiplex", {
			branchId: BRANCH,
			subscriptions: [
				{ id: "files", sql: "SELECT * FROM lix_file", params: [] },
				{ id: "dirs", sql: "SELECT * FROM lix_directory", params: [] },
			],
		}),
	);
	const body = await readSseUntil(response, [
		'"subscriptionId":"files"',
		'"subscriptionId":"dirs"',
	]);

	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	assert.match(body, /event: next\ndata: .*"subscriptionId":"files"/);
	assert.match(body, /event: next\ndata: .*"subscriptionId":"dirs"/);
	assert.match(body, /"mutationSequence":0/);
});

void test("multiplex observations scope query errors to their subscription", async () => {
	const binding = fakeBinding({
		execute: async (sql: string) => {
			if (sql === "FAIL") {
				throw Object.assign(new Error("invalid observed query"), {
					code: "LIX_PARSE_ERROR",
				});
			}
			return {
				columns: ["value"],
				rows: [[{ kind: "text", value: "healthy" }]],
				rowsAffected: 0,
				notices: [],
			};
		},
	});
	const runtime = testRuntime(async () => binding);
	const response = await runtime.fetch(
		WORKSPACE_A,
		workspaceRequest("/observe/multiplex", {
			branchId: BRANCH,
			subscriptions: [
				{ id: "broken", sql: "FAIL", params: [] },
				{ id: "healthy", sql: "SELECT 1", params: [] },
			],
		}),
	);
	const body = await readSseUntil(response, [
		'"subscriptionId":"broken"',
		'"subscriptionId":"healthy"',
	]);

	assert.match(
		body,
		/event: error\ndata: .*"subscriptionId":"broken".*"code":"LIX_PARSE_ERROR"/,
	);
	assert.match(
		body,
		/event: next\ndata: .*"subscriptionId":"healthy".*"value":"healthy"/,
	);
});

void test("multiplex observations expose stream-wide snapshot errors", async () => {
	let opens = 0;
	const runtime = testRuntime(async () => {
		opens += 1;
		if (opens === 2) throw new Error("corrupt snapshot bytes");
		return fakeBinding();
	});
	const response = await runtime.fetch(
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

	assert.match(
		body,
		/event: error\ndata: .*"code":"PREVIEW_SNAPSHOT_INVALID".*"message":"stored preview snapshot is invalid"/,
	);
	assert.doesNotMatch(body, /"subscriptionId"/);
});

function fakeBinding(
	overrides: Record<string, unknown> = {},
): MemoryLixBinding {
	const binding = {
		execute: async (sql: string) =>
			sql.includes("FROM lix_branch") ? branchResult() : emptyResult(),
		observe: async () => ({ close: () => undefined, next: async () => null }),
		beginTransaction: async () => ({
			execute: async () => emptyResult(),
			commit: async () => undefined,
			rollback: async () => undefined,
		}),
		activeBranchId: async () => BRANCH,
		createBranch: async ({ id, name }) => ({
			id: id ?? BRANCH,
			name,
			hidden: false,
			commitId: "commit-1",
		}),
		switchBranch: async ({ branchId }) => ({ branchId }),
		exportSnapshot: async () => new Uint8Array(),
		close: async () => undefined,
		...overrides,
	} as MemoryLixBinding;
	return binding;
}

function testRuntime(
	openMemoryLix: () => Promise<MemoryLixBinding>,
	mainBranchId = BRANCH,
	parseSqlScript: ParseSqlScript = singleStatementParser,
) {
	return createMemoryWorkspaceRuntime(openMemoryLix, {
		mainBranchId,
		parseSqlScript,
	});
}

const singleStatementParser: ParseSqlScript = (sql, providedParamCount) => ({
	statements: [
		{
			sql,
			paramStart: 0,
			paramEnd: providedParamCount,
		},
	],
});

function statefulBranchBinding(initialBranchId: string): MemoryLixBinding {
	let activeBranchId = initialBranchId;
	const branches = new Map([
		["global", { name: "global", hidden: true }],
		[initialBranchId, { name: "main", hidden: false }],
	]);
	return fakeBinding({
		activeBranchId: async () => activeBranchId,
		createBranch: async ({ id, name }: { id?: string; name: string }) => {
			assert.ok(id);
			branches.set(id, { name, hidden: false });
			return { id, name, hidden: false, commitId: "commit-1" };
		},
		switchBranch: async ({ branchId }: { branchId: string }) => {
			if (!branches.has(branchId)) {
				throw Object.assign(new Error(`branch missing: ${branchId}`), {
					code: "LIX_BRANCH_NOT_FOUND",
				});
			}
			activeBranchId = branchId;
			return { branchId };
		},
		execute: async (sql: string, params: unknown[]) => {
			if (sql.startsWith("DELETE FROM lix_branch")) {
				return mutationResult(branches.delete(nativeText(params[0])) ? 1 : 0);
			}
			if (sql.startsWith("UPDATE lix_branch SET name")) {
				const id = nativeText(params[1]);
				const branch = branches.get(id);
				if (!branch) return mutationResult(0);
				branch.name = nativeText(params[0]);
				return mutationResult(1);
			}
			if (sql.includes("FROM lix_branch")) {
				return branchesResult(branches);
			}
			return emptyResult();
		},
	});
}

function branchesResult(
	branches: Map<string, { name: string; hidden: boolean }>,
) {
	return {
		columns: ["id", "name", "hidden", "commit_id"],
		rows: [...branches.entries()]
			.sort((left, right) => left[1].name.localeCompare(right[1].name))
			.map(([id, branch]) => [
				{ kind: "text", value: id },
				{ kind: "text", value: branch.name },
				{ kind: "boolean", value: branch.hidden },
				{ kind: "text", value: "commit-1" },
			]),
		rowsAffected: 0,
		notices: [],
	};
}

function mainBranch(value: unknown): { id: string; name: string } {
	assert.ok(typeof value === "object" && value !== null && "branches" in value);
	const branches = (value as { branches: Array<{ id: string; name: string }> })
		.branches;
	const main = branches.find((branch) => branch.name === "main");
	assert.ok(main);
	return main;
}

function currentBranchId(value: unknown): string {
	assert.ok(
		typeof value === "object" &&
			value !== null &&
			"currentBranchId" in value &&
			typeof value.currentBranchId === "string",
	);
	return value.currentBranchId;
}

function nativeText(value: unknown): string {
	assert.ok(
		typeof value === "object" &&
			value !== null &&
			"kind" in value &&
			value.kind === "text" &&
			"value" in value &&
			typeof value.value === "string",
	);
	return value.value;
}

function mutationResult(rowsAffected: number) {
	return { ...emptyResult(), rowsAffected };
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

async function readSseUntil(
	response: Response,
	patterns: readonly string[],
): Promise<string> {
	assert.ok(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let body = "";
	try {
		while (!patterns.every((pattern) => body.includes(pattern))) {
			const result = await reader.read();
			if (result.done) break;
			body += decoder.decode(result.value, { stream: true });
		}
		return body;
	} finally {
		await reader.cancel();
	}
}
