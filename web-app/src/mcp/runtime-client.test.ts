import assert from "node:assert/strict";
import test from "node:test";
import {
	WorkerLixRuntimeClient,
	type WorkerLixRuntimeEnv,
} from "./runtime-client.ts";
import { isLixError } from "./lix-service.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

async function branchProtocolResponse(request: Request): Promise<Response> {
	const pathname = testProtocolPath(request);
	if (pathname === "/lix/v1/") {
		return Response.json({
			protocolVersion: 8,
			activeBranchId: "main",
			activeAccountId: "00000000-0000-7000-8000-000000000002",
			sessionId: "runtime-client-session",
		});
	}
	if (pathname === "/lix/v1/session" && request.method === "DELETE") {
		return new Response(null, { status: 204 });
	}
	if (pathname === "/lix/v1/execute") {
		return Response.json({
			columns: [
				{ name: "id", type: "text" },
				{ name: "name", type: "text" },
				{ name: "hidden", type: "boolean" },
				{ name: "commit_id", type: "text" },
			],
			rows: [
				[
					{ kind: "text", value: "main" },
					{ kind: "text", value: "main" },
					{ kind: "bool", value: false },
					{ kind: "text", value: "commit-1" },
				],
			],
			rowsAffected: 0,
			notices: [],
		});
	}
	if (pathname === "/lix/v1/branch/switch") {
		const body = JSON.parse(await request.text()) as { branchId: string };
		return Response.json({ branchId: body.branchId });
	}
	if (pathname === "/lix/v1/execute-batch") {
		return Response.json([
			{
				statementIndex: 0,
				columns: [],
				rows: [],
				rowsAffected: 0,
				notices: [],
			},
		]);
	}
	return new Response("Not found", { status: 404 });
}

function testProtocolPath(request: Request): string {
	return new URL(request.url).pathname.replace(/^\/lix\/v1\/[^/]+/, "/lix/v1");
}

function env(): WorkerLixRuntimeEnv {
	return {
		SUPABASE_URL: "https://project.supabase.co",
		SUPABASE_PUBLISHABLE_KEY: "publishable-key",
	};
}

function client(
	fetcher: (lixId: string, request: Request) => Promise<Response>,
	authorize: (lixId: string) => Promise<Response | null> = async () => null,
): WorkerLixRuntimeClient {
	return new WorkerLixRuntimeClient(
		env(),
		{ userId: "user-1", token: "secret-oauth-token" },
		async (lixId) => authorize(lixId),
		{ lixFetch: fetcher },
	);
}

void test("Railway Lix fetch strips OAuth and adds the trusted principal", async () => {
	let authorizationChecks = 0;
	const requests: Array<Request> = [];
	const runtime = client(
		async (_lixId, request) => {
			requests.push(request);
			return branchProtocolResponse(request);
		},
		async (lixId) => {
			authorizationChecks += 1;
			assert.equal(lixId, LIX_ID);
			return null;
		},
	);

	const response = await runtime.execute(LIX_ID, { sql: "SELECT 1" });

	assert.equal(response.rowsAffected, 0);
	assert.equal(authorizationChecks, 2);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		requests.map((request) => new URL(request.url).pathname),
		[`/lix/v1/${LIX_ID}/`, `/lix/v1/${LIX_ID}/execute`],
	);
	for (const request of requests) {
		assert.equal(request.headers.get("authorization"), null);
		assert.equal(
			request.headers.get("x-lixray-idempotency-principal"),
			"user-1",
		);
		assert.equal(
			(await request.clone().text()).includes("secret-oauth-token"),
			false,
		);
	}
});

void test("active branch, switch, and execution use one serialized Lix session", async () => {
	const operations: string[] = [];
	const runtime = client(async (_lixId, request) => {
		const pathname = testProtocolPath(request);
		if (pathname === "/lix/v1/") {
			operations.push("active-branch");
			return branchProtocolResponse(request);
		}
		if (pathname === "/lix/v1/branch/switch") {
			const body = JSON.parse(await request.text()) as { branchId: string };
			operations.push(`switch:${body.branchId}`);
			return Response.json({ branchId: body.branchId });
		}
		operations.push("execute");
		return Response.json({
			columns: [],
			rows: [],
			rowsAffected: 0,
			notices: [],
		});
	});

	const branchId = await runtime.activeBranchId(LIX_ID);
	assert.deepEqual(await runtime.switchBranch(LIX_ID, branchId), {
		branchId,
	});
	await runtime.execute(LIX_ID, { sql: "SELECT 1" });
	assert.deepEqual(operations, ["active-branch", "switch:main", "execute"]);
});

void test("executeBatch uses the canonical atomic endpoint", async () => {
	const requests: Array<Request> = [];
	const runtime = client(async (_lixId, request) => {
		requests.push(request);
		return branchProtocolResponse(request);
	});

	const response = await runtime.executeBatch(LIX_ID, {
		statements: [{ sql: "SELECT 1" }, { sql: "SELECT 2" }],
	});

	assert.equal(response.results.length, 1);
	assert.equal(
		new URL(requests.at(-1)?.url ?? "https://invalid").pathname,
		`/lix/v1/${LIX_ID}/execute-batch`,
	);
	assert.deepEqual(await requests.at(-1)?.json(), {
		statements: [
			{ sql: "SELECT 1", params: [] },
			{ sql: "SELECT 2", params: [] },
		],
	});
});

void test("Lix protocol errors retain status and structured error details", async () => {
	const runtime = client(async () =>
		Response.json(
			{ error: { code: "invalid_branch", message: "Invalid branch" } },
			{ status: 400 },
		),
	);

	await assert.rejects(runtime.activeBranchId(LIX_ID), (error: unknown) => {
		return (
			isLixError(error) &&
			error.code === "invalid_branch" &&
			error.status === 400 &&
			error.message === "Invalid branch"
		);
	});
});

void test("injected Lix summaries bypass Supabase discovery", async () => {
	const runtime = new WorkerLixRuntimeClient(
		env(),
		{ userId: "user-1", token: "token" },
		async () => null,
		{
			lixSummaries: [
				{
					id: LIX_ID,
					name: "Personal",
					slug: "personal",
					namespace: { id: "org-1", name: "Example", handle: "example" },
				},
			],
		},
	);

	assert.deepEqual(await runtime.listLixes(), [
		{
			id: LIX_ID,
			name: "Personal",
			slug: "personal",
			namespace: { id: "org-1", name: "Example", handle: "example" },
		},
	]);
});

void test("closing a Railway Lix session releases its remote session", async () => {
	const paths: string[] = [];
	const runtime = client(async (_lixId, request) => {
		paths.push(`${request.method} ${testProtocolPath(request)}`);
		return branchProtocolResponse(request);
	});

	await runtime.activeBranchId(LIX_ID);
	await runtime.close();
	assert.deepEqual(paths, ["GET /lix/v1/", "DELETE /lix/v1/session"]);
});

void test("execute maps protocol wire values through the SDK", async () => {
	const runtime = client(async (_lixId, request) => {
		if (testProtocolPath(request) === "/lix/v1/execute") {
			return Response.json({
				columns: [
					{ name: "n", type: "integer" },
					{ name: "when", type: "timestamptz" },
					{ name: "payload", type: "jsonb" },
					{ name: "bytes", type: "blob" },
				],
				rows: [
					[
						{ kind: "int", value: 7 },
						{ kind: "timestamptz", value: "2026-08-20T00:00:00Z" },
						{ kind: "jsonb", value: { ok: true } },
						{ kind: "blob", base64: "AQID" },
					],
				],
				rowsAffected: 0,
				notices: [],
			});
		}
		return branchProtocolResponse(request);
	});

	const response = await runtime.execute(LIX_ID, {
		sql: "SELECT $1, $2, $3, $4",
		params: [
			{ kind: "int", value: 7 },
			{ kind: "timestamp", value: "2026-08-20T00:00:00Z" },
			{ kind: "json", value: { ok: true } },
			{ kind: "blob", base64: "AQID" },
		],
	});

	assert.deepEqual(response.rows, [
		[
			{ kind: "int", value: 7 },
			{ kind: "timestamp", value: "2026-08-20T00:00:00.000000Z" },
			{ kind: "json", value: { ok: true } },
			{ kind: "blob", base64: "AQID" },
		],
	]);
});

void test("createBranch, undo, and redo use protocol HTTP", async () => {
	const paths: string[] = [];
	const runtime = client(async (_lixId, request) => {
		const pathname = testProtocolPath(request);
		paths.push(`${request.method} ${pathname}`);
		if (pathname === "/lix/v1/branch/create") {
			return Response.json({
				id: "draft",
				name: "Draft",
				hidden: false,
				commitId: "commit-2",
			});
		}
		if (pathname === "/lix/v1/undo") {
			return Response.json({
				branchId: "main",
				targetCommitId: "target",
				inverseCommitId: "inverse",
			});
		}
		if (pathname === "/lix/v1/redo") {
			return Response.json({
				branchId: "main",
				targetCommitId: "target",
				replayCommitId: "replay",
			});
		}
		return branchProtocolResponse(request);
	});

	assert.deepEqual(
		await runtime.createBranch(LIX_ID, "main", { name: "Draft" }),
		{
			id: "draft",
			name: "Draft",
			hidden: false,
			commitId: "commit-2",
		},
	);
	assert.deepEqual(await runtime.undo(LIX_ID, "main"), {
		branchId: "main",
		targetCommitId: "target",
		inverseCommitId: "inverse",
	});
	assert.deepEqual(await runtime.redo(LIX_ID, "main"), {
		branchId: "main",
		targetCommitId: "target",
		replayCommitId: "replay",
	});
	assert.deepEqual(paths.slice(1), [
		"POST /lix/v1/branch/create",
		"POST /lix/v1/undo",
		"POST /lix/v1/redo",
	]);
});

void test("remote merge and preview forward protocol requests and receipts", async () => {
	const requests: Array<{ path: string; method: string; body: unknown }> = [];
	const changeStats = { total: 3, added: 1, modified: 1, removed: 1 };
	const preview = {
		outcome: "mergeCommitted",
		targetBranchId: "main",
		sourceBranchId: "draft",
		baseCommitId: "base",
		targetHeadCommitId: "target",
		sourceHeadCommitId: "source",
		changeStats,
		conflicts: [],
	};
	const receipt = {
		outcome: "mergeCommitted",
		targetBranchId: "main",
		sourceBranchId: "draft",
		baseCommitId: "base",
		targetHeadBeforeCommitId: "target",
		sourceHeadBeforeCommitId: "source",
		targetHeadAfterCommitId: "merged",
		createdMergeCommitId: "merged",
		changeStats,
	};
	const runtime = client(async (_lixId, request) => {
		const path = testProtocolPath(request);
		if (
			path === "/lix/v1/branch/merge-preview" ||
			path === "/lix/v1/branch/merge"
		) {
			requests.push({
				path,
				method: request.method,
				body: await request.json(),
			});
			return Response.json(path.endsWith("merge-preview") ? preview : receipt);
		}
		return branchProtocolResponse(request);
	});
	assert.deepEqual(
		await runtime.mergeBranchPreview(LIX_ID, "main", "draft"),
		preview,
	);
	assert.deepEqual(await runtime.mergeBranch(LIX_ID, "main", "draft"), receipt);
	assert.deepEqual(
		requests,
		["merge-preview", "merge"].map((operation) => ({
			path: `/lix/v1/branch/${operation}`,
			method: "POST",
			body: { sourceBranchId: "draft" },
		})),
	);
	await runtime.close();
});
