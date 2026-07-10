import assert from "node:assert/strict";
import test from "node:test";
import {
	authenticateWithClerk,
	handleRequest,
	type AuthenticateRequest,
	type WorkerEnv,
} from "./handler.ts";
import { E2E_AUTH_TOKEN } from "../lib/e2e-auth.ts";

void test("GET /healthz returns Worker health without auth or proxying", async () => {
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

void test("non-/v1 routes delegate to the frontend fallback", async () => {
	const response = await handleRequest(
		new Request("https://example.test/"),
		env({}),
		{
			authenticate: authenticated("org_123"),
			fallback: async (request) =>
				new Response(`frontend ${new URL(request.url).pathname}`, {
					status: 209,
				}),
		},
	);

	assert.equal(response.status, 209);
	assert.equal(await response.text(), "frontend /");
});

void test("/v1 routes return 401 when Clerk auth fails", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({}),
		{ authenticate: rejected(401, "Unauthorized\n") },
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
});

void test("/v1 routes return 403 without an active workspace organization", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({}),
		{ authenticate: rejected(403, "Active workspace required\n") },
	);

	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Active workspace required\n");
});

void test("/v1 routes with Clerk org auth proxy to the org container", async () => {
	const calls: Array<unknown> = [];
	let startOptions: unknown;
	const response = await handleRequest(
		new Request("https://example.test/v1/container-health"),
		env({
			getByName: (name) => {
				calls.push(["getByName", name]);
				return {
					startAndWaitForPorts: async (options) => {
						startOptions = options;
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
	assert.deepEqual(startOptions, {
		ports: 8080,
		startOptions: {
			envVars: {
				R2_ENDPOINT: "https://r2.example",
				R2_BUCKET: "lixray",
				R2_ACCESS_KEY_ID: "access-key",
				R2_SECRET_ACCESS_KEY: "secret-key",
				R2_REGION: "auto",
				SLATEDB_PATH: "org_abc",
				SLATEDB_STORAGE: "r2",
				SLATEDB_CACHE_DIR: "/tmp/lixray-slatedb-cache",
				SLATEDB_CACHE_MAX_BYTES: "2147483648",
				SLATEDB_BLOCK_CACHE_BYTES: "134217728",
				SLATEDB_METADATA_CACHE_BYTES: "33554432",
			},
		},
	});
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
				SLATEDB_CACHE_DIR: "/tmp/lixray-slatedb-cache",
				SLATEDB_CACHE_MAX_BYTES: "2147483648",
				SLATEDB_BLOCK_CACHE_BYTES: "134217728",
				SLATEDB_METADATA_CACHE_BYTES: "33554432",
			},
		],
		["fetch", "/v1/container-health"],
	]);
});

void test("local e2e auth proxies to the configured e2e org container", async () => {
	const calls: Array<unknown> = [];
	const response = await handleRequest(
		new Request("http://localhost/v1/container-health", {
			headers: { Authorization: `Bearer ${E2E_AUTH_TOKEN}` },
		}),
		env({
			extra: { LIXRAY_E2E_ORG_ID: "org_e2e" },
			getByName: (name) => {
				calls.push(["getByName", name]);
				return {
					startAndWaitForPorts: async (options) => {
						calls.push(["start", options.startOptions.envVars.SLATEDB_PATH]);
					},
					fetch: async () => new Response("proxied", { status: 299 }),
				};
			},
		}),
	);

	assert.equal(response.status, 299);
	assert.deepEqual(calls, [
		["getByName", "org_e2e"],
		["start", "org_e2e"],
	]);
});

void test("e2e auth is ignored outside localhost", async () => {
	const response = await authenticateWithClerk(
		new Request("https://example.test/v1/container-health", {
			headers: { Authorization: `Bearer ${E2E_AUTH_TOKEN}` },
		}),
		env({ extra: { LIXRAY_E2E_ORG_ID: "org_e2e" } }),
	);

	assert.equal(response.ok, false);
	if (!response.ok) {
		assert.equal(response.response.status, 500);
		assert.equal(
			await response.response.text(),
			"CLERK_SECRET_KEY is not configured\n",
		);
	}
});

void test("legacy bearer token does not bypass Clerk auth", async () => {
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
		SLATEDB_CACHE_DIR: "/tmp/lixray-slatedb-cache",
		SLATEDB_CACHE_MAX_BYTES: "2147483648",
		SLATEDB_BLOCK_CACHE_BYTES: "134217728",
		SLATEDB_METADATA_CACHE_BYTES: "33554432",
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
	};
}
