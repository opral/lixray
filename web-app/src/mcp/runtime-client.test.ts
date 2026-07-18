import assert from "node:assert/strict";
import test from "node:test";
import {
	WorkerLixRuntimeClient,
	type WorkerLixRuntimeEnv,
} from "./runtime-client.ts";
import { FileServiceError } from "./file-service.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

async function branchProtocolResponse(request: Request): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	if (pathname === "/lix/v1/") {
		return Response.json({ protocolVersion: 1, activeBranchId: "main" });
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
		const body: { branchId: string } = await request.json();
		return Response.json({ branchId: body.branchId });
	}
	return new Response("Not found", { status: 404 });
}

void test("container calls reauthorize every time and never forward the OAuth token", async () => {
	let authorizationChecks = 0;
	let starts = 0;
	const requests: Array<Request> = [];
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: (name) => {
				assert.equal(name, WORKSPACE_ID);
				return {
					startAndWaitForPorts: async () => {
						starts += 1;
					},
					fetch: async (request) => {
						requests.push(request);
						return branchProtocolResponse(request);
					},
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async (workspaceId, user) => {
			authorizationChecks += 1;
			assert.equal(workspaceId, WORKSPACE_ID);
			assert.equal(user.token, "secret-oauth-token");
			return null;
		},
	);

	await client.listBranches(WORKSPACE_ID);
	await client.listBranches(WORKSPACE_ID);
	assert.equal(authorizationChecks, 5);
	assert.equal(starts, 5);
	assert.equal(requests.length, 5);
	assert.deepEqual(
		requests.map((request) => new URL(request.url).pathname),
		["/lix/v1/", "/lix/v1/", "/lix/v1/execute", "/lix/v1/", "/lix/v1/execute"],
	);
	for (const request of requests) {
		assert.equal(request.headers.get("authorization"), null);
		assert.equal(
			(await request.clone().text()).includes("secret-oauth-token"),
			false,
		);
	}
});

void test("transient container failures retry indefinitely with capped jitter and reacquired stubs", async () => {
	let acquisitions = 0;
	let starts = 0;
	let fetches = 0;
	const delays: Array<number> = [];
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async () => {
						starts += 1;
						if (starts <= 5) {
							throw new Error(
								"The container is not running, consider calling start()",
							);
						}
					},
					fetch: async (request) => {
						fetches += 1;
						return branchProtocolResponse(request);
					},
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			retryRandom: () => 1,
			retryDelay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		},
	);

	assert.equal((await client.listBranches(WORKSPACE_ID)).branches.length, 1);
	assert.equal(acquisitions, 8);
	assert.equal(starts, 8);
	assert.equal(fetches, 3);
	assert.deepEqual(delays, [1_000, 2_000, 4_000, 5_000, 5_000]);
});

void test("Durable Object storage resets are retried", async () => {
	let acquisitions = 0;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async () => {
						if (acquisitions === 1) {
							throw new Error(
								"Internal error in Durable Object storage caused object to be reset; reference = retry-me",
							);
						}
					},
					fetch: branchProtocolResponse,
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{ retryDelay: async () => undefined },
	);

	assert.equal((await client.listBranches(WORKSPACE_ID)).branches.length, 1);
	assert.equal(acquisitions, 4);
});

void test("transient HTTP responses retry and replay request bodies", async () => {
	let acquisitions = 0;
	const bodies: Array<unknown> = [];
	const delays: Array<number> = [];
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					fetch: async (request) => {
						const pathname = new URL(request.url).pathname;
						if (
							pathname === "/lix/v1/" ||
							pathname === "/lix/v1/branch/switch"
						) {
							return branchProtocolResponse(request);
						}
						bodies.push(await request.json());
						if (bodies.length === 1) {
							return new Response("Failed to start container: cold start", {
								status: 500,
							});
						}
						return Response.json({
							columns: [],
							rows: [],
							rowsAffected: 0,
							notices: [],
						});
					},
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			retryRandom: () => 1,
			retryDelay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		},
	);
	const request = {
		branchId: "main",
		sql: "SELECT $1",
		params: [{ kind: "text" as const, value: "ok" }],
	};

	assert.equal((await client.execute(WORKSPACE_ID, request)).rowsAffected, 0);
	assert.equal(acquisitions, 4);
	assert.deepEqual(bodies, [
		{ sql: request.sql, params: request.params },
		{ sql: request.sql, params: request.params },
	]);
	assert.deepEqual(delays, [1_000]);
});

void test("caller cancellation stops otherwise retryable container work", async () => {
	const controller = new AbortController();
	let acquisitions = 0;
	let observedCancellationOptions: unknown;
	let delays = 0;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async (options) => {
						observedCancellationOptions = options.cancellationOptions;
						queueMicrotask(() => controller.abort());
						return new Promise(() => undefined);
					},
					fetch: async () => new Response("unreachable"),
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			signal: controller.signal,
			retryDelay: async () => {
				delays += 1;
			},
		},
	);

	await assert.rejects(client.listBranches(WORKSPACE_ID), (error: unknown) => {
		return (
			error instanceof FileServiceError &&
			error.message === "Workspace storage request was cancelled."
		);
	});
	assert.equal(observedCancellationOptions, undefined);
	assert.equal(acquisitions, 1);
	assert.equal(delays, 0);
});

void test("non-zero container exits are not retried indefinitely", async () => {
	let acquisitions = 0;
	let delays = 0;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async () => {
						throw new Error(
							"Container exited before we could determine health, exit code: 1",
						);
					},
					fetch: async () => new Response("unreachable"),
				};
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			retryDelay: async () => {
				delays += 1;
			},
		},
	);

	await assert.rejects(client.listBranches(WORKSPACE_ID), (error: unknown) => {
		return error instanceof FileServiceError && error.code === "upstream_error";
	});
	assert.equal(acquisitions, 1);
	assert.equal(delays, 0);
});

void test("permanent container responses are not retried", async () => {
	let fetches = 0;
	let delays = 0;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async () => {
					fetches += 1;
					return Response.json(
						{ error: { message: "Invalid branch" } },
						{ status: 400 },
					);
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			retryDelay: async () => {
				delays += 1;
			},
		},
	);

	await assert.rejects(client.listBranches(WORKSPACE_ID), (error: unknown) => {
		return (
			error instanceof FileServiceError &&
			error.code === "upstream_error" &&
			error.details?.status === 400
		);
	});
	assert.equal(fetches, 1);
	assert.equal(delays, 0);
});

void test("a denied workspace never starts or calls a container", async () => {
	let touchedContainer = false;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => {
				touchedContainer = true;
				throw new Error("container should not be reached");
			},
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => new Response("Workspace access denied", { status: 403 }),
	);

	await assert.rejects(client.listBranches(WORKSPACE_ID), (error: unknown) => {
		return error instanceof FileServiceError && error.code === "not_found";
	});
	assert.equal(touchedContainer, false);
});

void test("unified Lix execute reauthorizes and strips the OAuth token", async () => {
	let authorizationChecks = 0;
	let received: Request | undefined;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async (request) => {
					const pathname = new URL(request.url).pathname;
					if (pathname === "/lix/v1/" || pathname === "/lix/v1/branch/switch") {
						return branchProtocolResponse(request);
					}
					received = request;
					return Response.json({
						columns: ["value"],
						rows: [[{ kind: "text", value: "ok" }]],
						rowsAffected: 0,
						notices: [],
					});
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => {
			authorizationChecks += 1;
			return null;
		},
	);

	const response = await client.execute(WORKSPACE_ID, {
		branchId: "main",
		sql: "SELECT $1 AS value",
		params: [{ kind: "text", value: "ok" }],
	});
	assert.equal(response.rowsAffected, 0);
	assert.equal(authorizationChecks, 3);
	assert.ok(received);
	assert.equal(new URL(received.url).pathname, "/lix/v1/execute");
	assert.equal(received.headers.get("authorization"), null);
	assert.deepEqual(await received.json(), {
		sql: "SELECT $1 AS value",
		params: [{ kind: "text", value: "ok" }],
	});
});

void test("unified Lix executeBatch uses the canonical atomic batch endpoint", async () => {
	let received: Request | undefined;
	const client = new WorkerLixRuntimeClient(
		{},
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			workspaceFetch: async (_workspaceId, request) => {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/lix/v1/" || pathname === "/lix/v1/branch/switch") {
					return branchProtocolResponse(request);
				}
				received = request;
				return Response.json([
					{
						columns: ["value"],
						rows: [[{ kind: "int", value: 1 }]],
						rowsAffected: 0,
						notices: [],
					},
					{
						columns: ["value"],
						rows: [[{ kind: "text", value: "two" }]],
						rowsAffected: 0,
						notices: [],
					},
				]);
			},
		},
	);

	const response = await client.executeBatch(WORKSPACE_ID, {
		branchId: "main",
		statements: [
			{ sql: "SELECT $1 AS value", params: [{ kind: "int", value: 1 }] },
			{
				sql: "SELECT $1 AS value",
				params: [{ kind: "text", value: "two" }],
			},
		],
		options: { originKey: "mcp-batch" },
	});

	assert.equal(response.results.length, 2);
	assert.ok(received);
	assert.equal(new URL(received.url).pathname, "/lix/v1/execute-batch");
	assert.deepEqual(await received.json(), {
		statements: [
			{ sql: "SELECT $1 AS value", params: [{ kind: "int", value: 1 }] },
			{
				sql: "SELECT $1 AS value",
				params: [{ kind: "text", value: "two" }],
			},
		],
		options: { originKey: "mcp-batch" },
	});
});

void test("unified Lix sessions serialize branch selection with execution", async () => {
	const operations: string[] = [];
	const client = new WorkerLixRuntimeClient(
		{},
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			workspaceFetch: async (_workspaceId, request) => {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/lix/v1/") {
					operations.push("handshake");
					return branchProtocolResponse(request);
				}
				if (pathname === "/lix/v1/branch/switch") {
					const body: { branchId: string } = await request.json();
					operations.push(`switch:${body.branchId}`);
					return Response.json({ branchId: body.branchId });
				}
				const body: { sql: string } = await request.json();
				const branchId = body.sql.endsWith("1") ? "branch-a" : "branch-b";
				operations.push(`execute:${branchId}`);
				return Response.json({
					columns: ["branch_id"],
					rows: [[{ kind: "text", value: branchId }]],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);

	const [first, second] = await Promise.all([
		client.execute(WORKSPACE_ID, { branchId: "branch-a", sql: "SELECT 1" }),
		client.execute(WORKSPACE_ID, { branchId: "branch-b", sql: "SELECT 2" }),
	]);

	assert.equal(first.rows[0]?.[0]?.kind, "text");
	assert.equal(second.rows[0]?.[0]?.kind, "text");
	assert.deepEqual(operations, [
		"handshake",
		"switch:branch-a",
		"execute:branch-a",
		"switch:branch-b",
		"execute:branch-b",
	]);
});

void test("unified Lix execute preserves every wire value kind", async () => {
	const params: NonNullable<
		import("./file-service.ts").ExecuteRequest["params"]
	> = [
		{ kind: "null", value: null },
		{ kind: "bool", value: true },
		{ kind: "int", value: 42 },
		{ kind: "float", value: 1.5 },
		{ kind: "text", value: "hello" },
		{ kind: "json", value: { nested: [true, null] } },
		{ kind: "blob", base64: "AQID" },
	];
	let receivedParams: unknown;
	const client = new WorkerLixRuntimeClient(
		{},
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			workspaceFetch: async (_workspaceId, request) => {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/lix/v1/" || pathname === "/lix/v1/branch/switch") {
					return branchProtocolResponse(request);
				}
				const body: { params: typeof params } = await request.json();
				receivedParams = body.params;
				return Response.json({
					columns: params.map((_, index) => `value_${index}`),
					rows: [body.params],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);

	const result = await client.execute(WORKSPACE_ID, {
		branchId: "main",
		sql: "SELECT values",
		params,
	});

	assert.deepEqual(receivedParams, params);
	assert.deepEqual(result.rows, [params]);
});

void test("unified Lix execute preserves structured Lix errors", async () => {
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async (request) => {
					const pathname = new URL(request.url).pathname;
					if (pathname === "/lix/v1/" || pathname === "/lix/v1/branch/switch") {
						return branchProtocolResponse(request);
					}
					return Response.json(
						{
							error: {
								code: "LIX_UNSUPPORTED_SQL",
								message: "Unsupported transaction control",
								hint: "Use BEGIN ... COMMIT.",
								details: { operation: "execute" },
							},
						},
						{ status: 400 },
					);
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
	);

	await assert.rejects(
		client.execute(WORKSPACE_ID, {
			branchId: "main",
			sql: "BEGIN; COMMIT",
		}),
		(error: unknown) =>
			error instanceof FileServiceError &&
			error.code === "LIX_UNSUPPORTED_SQL" &&
			error.details?.status === 400 &&
			error.details?.hint === "Use BEGIN ... COMMIT." &&
			error.details?.operation === "execute",
	);
});

void test("injected workspaces and workspace fetch bypass Supabase and containers", async () => {
	let authorizationChecks = 0;
	const received: Request[] = [];
	const workspaceSummaries = [
		{
			id: WORKSPACE_ID,
			name: "Demo workspace",
			slug: "demo-workspace",
			organization: { id: "org-demo", name: "Demo", handle: "demo" },
		},
	];
	const client = new WorkerLixRuntimeClient(
		{},
		{ userId: "lixray-demo", token: "lixray-demo" },
		async (workspaceId) => {
			authorizationChecks += 1;
			assert.equal(workspaceId, WORKSPACE_ID);
			return null;
		},
		{
			workspaceSummaries,
			workspaceFetch: async (workspaceId, request) => {
				assert.equal(workspaceId, WORKSPACE_ID);
				received.push(request);
				return branchProtocolResponse(request);
			},
		},
	);

	assert.deepEqual(await client.listWorkspaces(), workspaceSummaries);
	assert.deepEqual(await client.listBranches(WORKSPACE_ID), {
		branches: [
			{ id: "main", name: "main", hidden: false, commitId: "commit-1" },
		],
		currentBranchId: "main",
	});
	assert.equal(authorizationChecks, 3);
	assert.deepEqual(
		received.map((request) => new URL(request.url).pathname),
		["/lix/v1/", "/lix/v1/", "/lix/v1/execute"],
	);
	for (const request of received) {
		assert.equal(request.headers.get("authorization"), null);
	}
});

void test("workspace discovery uses the OAuth token and only joins RLS-visible rows", async () => {
	const requests: Array<{ url: URL; headers: Headers }> = [];
	const client = new WorkerLixRuntimeClient(
		env({}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			fetcher: async (input, init) => {
				const url = new URL(
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input.url,
				);
				requests.push({ url, headers: new Headers(init?.headers) });
				if (url.pathname.endsWith("/organizations")) {
					return Response.json([
						{ id: "org-1", name: "Example", handle: "example" },
					]);
				}
				return Response.json([
					{
						id: WORKSPACE_ID,
						organization_id: "org-1",
						name: "Personal",
						slug: "personal",
					},
					{
						id: "hidden",
						organization_id: "not-visible",
						name: "Hidden",
						slug: "hidden",
					},
				]);
			},
		},
	);

	assert.deepEqual(await client.listWorkspaces(), [
		{
			id: WORKSPACE_ID,
			name: "Personal",
			slug: "personal",
			organization: { id: "org-1", name: "Example", handle: "example" },
		},
	]);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(
			request.headers.get("authorization"),
			"Bearer secret-oauth-token",
		);
		assert.equal(request.headers.get("apikey"), "publishable-key");
	}
	assert.equal(
		requests
			.find(({ url }) => url.pathname.endsWith("/workspaces"))
			?.url.searchParams.get("select"),
		"id,organization_id,name,slug",
	);
	assert.equal(
		requests
			.find(({ url }) => url.pathname.endsWith("/organizations"))
			?.url.searchParams.get("select"),
		"id,name,handle",
	);
});

void test("workspace discovery invokes the Worker fetch function without a class receiver", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = function (
		this: unknown,
		input: RequestInfo | URL,
	): Promise<Response> {
		assert.equal(this, undefined);
		calls += 1;
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		return Promise.resolve(
			url.pathname.endsWith("/organizations")
				? Response.json([{ id: "org-1", name: "Example", handle: "example" }])
				: Response.json([
						{
							id: WORKSPACE_ID,
							organization_id: "org-1",
							name: "Personal",
							slug: "personal",
						},
					]),
		);
	};
	try {
		const client = new WorkerLixRuntimeClient(
			env({}),
			{ userId: "user-1", token: "secret-oauth-token" },
			async () => null,
		);
		assert.equal((await client.listWorkspaces()).length, 1);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function env(options: {
	getByName?: NonNullable<
		WorkerLixRuntimeEnv["SLATEDB_CONTAINER"]
	>["getByName"];
}): WorkerLixRuntimeEnv {
	return {
		SUPABASE_URL: "https://project.supabase.co",
		SUPABASE_PUBLISHABLE_KEY: "publishable-key",
		SLATEDB_CONTAINER: {
			getByName:
				options.getByName ??
				(() => ({ fetch: async () => new Response("not used") })),
		},
	};
}
