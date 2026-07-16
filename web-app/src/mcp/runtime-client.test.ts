import assert from "node:assert/strict";
import test from "node:test";
import {
	WorkerLixRuntimeClient,
	type WorkerLixRuntimeEnv,
} from "./runtime-client.ts";
import { FileServiceError } from "./file-service.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

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
						return Response.json({
							currentBranchId: "main",
							branches: [
								{
									id: "main",
									name: "main",
									hidden: false,
									commitId: "commit-1",
								},
							],
						});
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
	assert.equal(authorizationChecks, 2);
	assert.equal(starts, 2);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(new URL(request.url).pathname, "/v1/branches");
		assert.equal(request.headers.get("authorization"), null);
		assert.equal(
			(await request.clone().text()).includes("secret-oauth-token"),
			false,
		);
	}
});

void test("transient container failures retry indefinitely with one-second delays", async () => {
	let starts = 0;
	let fetches = 0;
	const delays: Array<number> = [];
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				startAndWaitForPorts: async () => {
					starts += 1;
					if (starts <= 5) {
						throw new Error(
							"The container is not running, consider calling start()",
						);
					}
				},
				fetch: async () => {
					fetches += 1;
					return Response.json({
						currentBranchId: "main",
						branches: [
							{
								id: "main",
								name: "main",
								hidden: false,
								commitId: "commit-1",
							},
						],
					});
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
			retryDelay: async (milliseconds) => {
				delays.push(milliseconds);
			},
		},
	);

	assert.equal((await client.listBranches(WORKSPACE_ID)).branches.length, 1);
	assert.equal(starts, 6);
	assert.equal(fetches, 1);
	assert.deepEqual(delays, [1_000, 1_000, 1_000, 1_000, 1_000]);
});

void test("transient HTTP responses retry and replay request bodies", async () => {
	const bodies: Array<unknown> = [];
	const delays: Array<number> = [];
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async (request) => {
					bodies.push(await request.json());
					if (bodies.length === 1) {
						return new Response("Failed to start container: cold start", {
							status: 500,
						});
					}
					return Response.json({
						results: [
							{
								columns: [],
								rows: [],
								rowsAffected: 0,
								notices: [],
							},
						],
					});
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
		{
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
	assert.deepEqual(bodies, [request, request]);
	assert.deepEqual(delays, [1_000]);
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

void test("raw execute reauthorizes and strips the OAuth token", async () => {
	let authorizationChecks = 0;
	let received: Request | undefined;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async (request) => {
					received = request;
					return Response.json({
						results: [
							{
								columns: ["value"],
								rows: [[{ kind: "text", value: "ok" }]],
								rowsAffected: 0,
								notices: [],
							},
						],
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

	const response = await client.executeScript(WORKSPACE_ID, {
		branchId: "main",
		sql: "SELECT $1 AS value",
		params: [{ kind: "text", value: "ok" }],
	});
	assert.equal(response.results[0]?.rowsAffected, 0);
	assert.equal(authorizationChecks, 1);
	assert.ok(received);
	assert.equal(new URL(received.url).pathname, "/v1/execute");
	assert.equal(received.headers.get("authorization"), null);
	assert.deepEqual(await received.json(), {
		branchId: "main",
		sql: "SELECT $1 AS value",
		params: [{ kind: "text", value: "ok" }],
	});
});

void test("raw execute preserves structured Lix script errors", async () => {
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async () =>
					Response.json(
						{
							error: {
								code: "LIX_UNSUPPORTED_SQL",
								message: "Unsupported transaction control",
								hint: "Use BEGIN ... COMMIT.",
								details: { operation: "execute" },
							},
						},
						{ status: 400 },
					),
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
	);

	await assert.rejects(
		client.executeScript(WORKSPACE_ID, {
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
	let received: Request | undefined;
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
				received = request;
				return Response.json({
					currentBranchId: "main",
					branches: [
						{
							id: "main",
							name: "main",
							hidden: false,
							commitId: "commit-1",
						},
					],
				});
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
	assert.equal(authorizationChecks, 1);
	assert.ok(received);
	assert.equal(new URL(received.url).pathname, "/v1/branches");
	assert.equal(received.headers.get("authorization"), null);
});

void test("filesystem mutations use the typed container endpoint without forwarding auth", async () => {
	let received: Request | undefined;
	const client = new WorkerLixRuntimeClient(
		env({
			getByName: () => ({
				fetch: async (request) => {
					received = request;
					return Response.json({ outcome: "applied" });
				},
			}),
		}),
		{ userId: "user-1", token: "secret-oauth-token" },
		async () => null,
	);

	const outcome = await client.mutate(WORKSPACE_ID, {
		branchId: "main",
		kind: "file",
		path: "/old.txt",
		expectedRevision: "revision-1",
		mutation: { type: "move", destinationPath: "/new.txt" },
	});
	assert.equal(outcome, "applied");
	assert.ok(received);
	assert.equal(new URL(received.url).pathname, "/v1/filesystem/mutate");
	assert.equal(received.headers.get("authorization"), null);
	assert.deepEqual(await received.json(), {
		branchId: "main",
		kind: "file",
		path: "/old.txt",
		expectedRevision: "revision-1",
		mutation: { type: "move", destinationPath: "/new.txt" },
	});
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
