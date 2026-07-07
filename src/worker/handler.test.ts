import assert from "node:assert/strict";
import test from "node:test";
import {
	handleRequest,
	type AuthenticateRequest,
	type WorkerEnv,
} from "./handler.ts";

test("GET /healthz returns Worker health without auth or proxying", async () => {
	let proxied = false;
	const response = await handleRequest(
		new Request("https://example.test/healthz"),
		env({
			fetch: async () => {
				proxied = true;
				return new Response(null, { status: 204 });
			},
		}),
		{ authenticate: authenticated("org_123") },
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, service: "lixray" });
	assert.equal(proxied, false);
});

test("non-/v1 routes delegate to the frontend fallback", async () => {
	const response = await handleRequest(
		new Request("https://example.test/"),
		env({}),
		{
			authenticate: authenticated("org_123"),
			fallback: async (request) =>
				new Response(`frontend ${new URL(request.url).pathname}`, { status: 209 }),
		},
	);

	assert.equal(response.status, 209);
	assert.equal(await response.text(), "frontend /");
});

test("/v1 routes return 401 when Clerk auth fails", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({}),
		{ authenticate: rejected(401, "Unauthorized\n") },
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
});

test("/v1 routes return 403 without an active workspace organization", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({}),
		{ authenticate: rejected(403, "Active workspace required\n") },
	);

	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Active workspace required\n");
});

test("/v1 routes with Clerk org auth proxy to the org container", async () => {
	const calls: Array<unknown> = [];
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({
			getByName: (name) => {
				calls.push(["getByName", name]);
				return {
					startAndWaitForPorts: async (options) => {
						calls.push(["start", options.startOptions.envVars]);
					},
					fetch: async (request) => {
						calls.push(["fetch", new URL(request.url).pathname]);
						return new Response("proxied", { status: 299 });
					},
				};
			},
		}),
		{ authenticate: authenticated("org_abc") },
	);

	assert.equal(response.status, 299);
	assert.deepEqual(calls, [
		["getByName", "org_abc"],
		[
			"start",
			{
				R2_ENDPOINT: "https://r2.example",
				R2_BUCKET: "lixray",
				R2_ACCESS_KEY_ID: "access-key",
				R2_SECRET_ACCESS_KEY: "secret-key",
				R2_REGION: "auto",
				SLATEDB_PATH: "org_abc",
				SLATEDB_STORAGE: "r2",
			},
		],
		["fetch", "/v1/container-health"],
	]);
});

test("legacy bearer token does not bypass Clerk auth", async () => {
	let proxied = false;
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health", {
			headers: { Authorization: "Bearer legacy-secret" },
		}),
		env({
			extra: { LIXRAY_AUTH_TOKEN: "legacy-secret" },
			fetch: async () => {
				proxied = true;
				return new Response("proxied", { status: 299 });
			},
		}),
		{ authenticate: rejected(401, "Unauthorized\n") },
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
	assert.equal(proxied, false);
});

function authenticated(orgId: string): AuthenticateRequest {
	return async () => ({ ok: true, orgId });
}

function rejected(status: number, body: string): AuthenticateRequest {
	return async () => ({
		ok: false,
		response: new Response(body, { status }),
	});
}

function env(options: {
	fetch?: (request: Request) => Promise<Response>;
	getByName?: WorkerEnv["SLATEDB_CONTAINER"]["getByName"];
	extra?: Record<string, unknown>;
}): WorkerEnv {
	return {
		R2_ENDPOINT: "https://r2.example",
		R2_BUCKET: "lixray",
		R2_ACCESS_KEY_ID: "access-key",
		R2_SECRET_ACCESS_KEY: "secret-key",
		R2_REGION: "auto",
		SLATEDB_STORAGE: "r2",
		SLATEDB_CONTAINER: {
			getByName:
				options.getByName ??
				(() => ({
					fetch:
						options.fetch ??
						(async () => new Response("proxied", { status: 200 })),
				})),
		},
		...options.extra,
	} as WorkerEnv;
}
