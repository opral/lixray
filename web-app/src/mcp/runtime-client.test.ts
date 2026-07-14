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

void test("injected workspaces and workspace fetch bypass Supabase and containers", async () => {
	let authorizationChecks = 0;
	let received: Request | undefined;
	const workspaceSummaries = [
		{
			id: WORKSPACE_ID,
			name: "Demo workspace",
			organization: { id: "org-demo", name: "Demo" },
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
	assert.deepEqual(await client.listBranches(WORKSPACE_ID), [
		{ id: "main", name: "main", hidden: false, commitId: "commit-1" },
	]);
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
					return Response.json([{ id: "org-1", name: "Example" }]);
				}
				return Response.json([
					{ id: WORKSPACE_ID, organization_id: "org-1", name: "Personal" },
					{ id: "hidden", organization_id: "not-visible", name: "Hidden" },
				]);
			},
		},
	);

	assert.deepEqual(await client.listWorkspaces(), [
		{
			id: WORKSPACE_ID,
			name: "Personal",
			organization: { id: "org-1", name: "Example" },
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
				? Response.json([{ id: "org-1", name: "Example" }])
				: Response.json([
						{
							id: WORKSPACE_ID,
							organization_id: "org-1",
							name: "Personal",
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
