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
			protocolVersion: 2,
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
			columns: ["id", "name", "hidden", "commit_id"],
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
	return new URL(request.url).pathname.replace(/^\/lixes\/[^/]+/, "");
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
		["/lix/v1/", "/lix/v1/execute"],
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
		"/lix/v1/execute-batch",
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
