import assert from "node:assert/strict";
import test from "node:test";
import { E2E_AUTH_TOKEN, E2E_WORKSPACE_ID } from "../lib/e2e-auth.ts";
import {
	authenticateWithSupabase,
	authorizeWorkspaceWithSupabase,
	handleRequest,
	validateBrowserJwtClaims,
	validateMcpJwtClaims,
	type AuthenticateRequest,
	type AuthenticateMcpRequest,
	type AuthorizeWorkspace,
	type WorkerEnv,
} from "./handler.ts";
import {
	MCP_AUTHORIZATION_SERVER,
	MCP_PROTECTED_RESOURCE_PATH,
	MCP_RESOURCE,
} from "../mcp/server.ts";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

void test("GET /healthz returns Worker health without auth or proxying", async () => {
	let proxied = false;
	const response = await handleRequest(
		new Request("https://example.test/healthz"),
		env({
			fetch: async () => {
				proxied = true;
				return new Response();
			},
		}),
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
			fallback: async (request) =>
				new Response(`frontend ${new URL(request.url).pathname}`, {
					status: 209,
				}),
		},
	);
	assert.equal(response.status, 209);
	assert.equal(await response.text(), "frontend /");
});

void test("protected resource discovery is public and precedes the frontend fallback", async () => {
	let fellBack = false;
	const response = await handleRequest(
		new Request(`https://example.test${MCP_PROTECTED_RESOURCE_PATH}`),
		env({}),
		{
			fallback: async () => {
				fellBack = true;
				return new Response("frontend");
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(fellBack, false);
	assert.deepEqual(await response.json(), {
		resource: MCP_RESOURCE,
		authorization_servers: [MCP_AUTHORIZATION_SERVER],
		scopes_supported: ["openid", "email", "profile"],
		resource_documentation: "https://lixray.com/docs/mcp",
	});
});

void test("unauthenticated MCP discovery returns an OAuth resource challenge before fallback", async () => {
	let fellBack = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", {
			headers: { Accept: "application/json, text/event-stream" },
		}),
		env({}),
		{
			authenticateMcp: async () => ({
				ok: false,
				response: new Response("Unauthorized", {
					status: 401,
					headers: {
						"WWW-Authenticate":
							'Bearer resource_metadata="https://lixray.com/.well-known/oauth-protected-resource"',
					},
				}),
			}),
			fallback: async () => {
				fellBack = true;
				return new Response("frontend");
			},
		},
	);
	assert.equal(response.status, 401);
	assert.match(
		response.headers.get("www-authenticate") ?? "",
		/resource_metadata="https:\/\/lixray\.com\/\.well-known\/oauth-protected-resource"/,
	);
	assert.equal(fellBack, false);
});

void test("authenticated MCP initialize reaches the MCP transport before fallback", async () => {
	let fellBack = false;
	let reachedTransport = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer oauth-user-token",
				Accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "handler-test", version: "1.0.0" },
				},
			}),
		}),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			mcpTransport: async () => {
				reachedTransport = true;
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: {
						serverInfo: { name: "lixray", version: "0.1.0" },
						capabilities: { tools: {} },
					},
				});
			},
			fallback: async () => {
				fellBack = true;
				return new Response("frontend");
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(fellBack, false);
	assert.equal(reachedTransport, true);
	const payload: unknown = await response.json();
	assert.ok(isRecord(payload));
	assert.ok(isRecord(payload.result));
	assert.ok(isRecord(payload.result.serverInfo));
	assert.equal(payload.result.serverInfo.name, "lixray");
	assert.ok(payload.result.capabilities);
});

void test("MCP JWT claims require issuer, audience, expiry, OAuth client, and resource binding", () => {
	const issuer = "https://project.supabase.co/auth/v1";
	const now = 1_800_000_000;
	const valid = {
		iss: issuer,
		aud: "authenticated",
		exp: now + 300,
		sub: "user-123",
		role: "authenticated",
		client_id: "chatgpt-client",
		resource: MCP_RESOURCE,
		lixray_mcp: true,
		scope: "openid email profile",
	};
	assert.deepEqual(validateMcpJwtClaims(valid, issuer, now), {
		ok: true,
		userId: "user-123",
		clientId: "chatgpt-client",
	});

	for (const claims of [
		{ ...valid, iss: "https://attacker.invalid/auth/v1" },
		{ ...valid, aud: "anon" },
		{ ...valid, exp: now },
		{ ...valid, role: "anon" },
	]) {
		const result = validateMcpJwtClaims(claims, issuer, now);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "invalid_token");
	}

	for (const claims of [
		{ ...valid, client_id: undefined },
		{ ...valid, resource: "https://other.example" },
		{ ...valid, lixray_mcp: false },
		{ ...valid, scope: "email profile" },
	]) {
		const result = validateMcpJwtClaims(claims, issuer, now);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "insufficient_scope");
	}
});

void test("browser /v1 claims reject OAuth clients while normal sessions are unchanged", () => {
	const browserClaims = {
		sub: "user-123",
		role: "authenticated",
		aud: "authenticated",
	};
	assert.equal(validateBrowserJwtClaims(browserClaims), true);
	assert.equal(
		validateBrowserJwtClaims({
			...browserClaims,
			client_id: "chatgpt-client",
			resource: MCP_RESOURCE,
			lixray_mcp: true,
		}),
		false,
	);
	assert.equal(
		validateBrowserJwtClaims({ ...browserClaims, role: "anon" }),
		false,
	);
});

void test("legacy unscoped /v1 routes return 404 before auth", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/branches"),
		env({}),
		{
			authenticate: async () => {
				throw new Error("auth should not run");
			},
		},
	);
	assert.equal(response.status, 404);
});

void test("malformed workspace ids return 400 before auth", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/workspaces/not-a-uuid/branches"),
		env({}),
		{
			authenticate: async () => {
				throw new Error("auth should not run");
			},
		},
	);
	assert.equal(response.status, 400);
	assert.equal(await response.text(), "Invalid workspace id\n");
});

void test("workspace routes return authentication failures", async () => {
	const response = await handleRequest(
		workspaceRequest(WORKSPACE_A, "/branches"),
		env({}),
		{
			authenticate: rejected(401, "Unauthorized\n"),
		},
	);
	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
});

void test("inaccessible workspaces return 403 without starting a container", async () => {
	let started = false;
	const response = await handleRequest(
		workspaceRequest(WORKSPACE_A, "/branches"),
		env({
			fetch: async () => {
				started = true;
				return new Response();
			},
		}),
		{ authenticate: authenticated(), authorizeWorkspace: denied() },
	);
	assert.equal(response.status, 403);
	assert.equal(started, false);
});

void test("authorized requests route by workspace, rewrite paths, preserve bodies and strip auth", async () => {
	let startOptions: unknown;
	let proxiedRequest: Request | undefined;
	const request = workspaceRequest(WORKSPACE_A, "/execute?mode=test", {
		method: "POST",
		headers: {
			Authorization: "Bearer user-token",
			"content-type": "application/json",
			"x-client-header": "kept",
		},
		body: JSON.stringify({ sql: "SELECT 1" }),
	});
	const response = await handleRequest(
		request,
		env({
			getByName: (name) => {
				assert.equal(name, WORKSPACE_A);
				return {
					startAndWaitForPorts: async (options) => {
						startOptions = options;
					},
					fetch: async (incoming) => {
						proxiedRequest = incoming;
						return new Response("event: next\ndata: {}\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						});
					},
				};
			},
		}),
		{ authenticate: authenticated(), authorizeWorkspace: allowed() },
	);

	assert.equal(response.headers.get("content-type"), "text/event-stream");
	assert.deepEqual(startOptions, {
		ports: 8080,
		startOptions: {
			envVars: {
				R2_ENDPOINT: "https://r2.example",
				R2_BUCKET: "lixray",
				R2_ACCESS_KEY_ID: "access-key",
				R2_SECRET_ACCESS_KEY: "secret-key",
				R2_REGION: "auto",
				SLATEDB_PATH: WORKSPACE_A,
				SLATEDB_STORAGE: "r2",
				SLATEDB_CACHE_DIR: "/tmp/lixray-slatedb-cache",
				SLATEDB_CACHE_MAX_BYTES: "2147483648",
				SLATEDB_BLOCK_CACHE_BYTES: "134217728",
				SLATEDB_METADATA_CACHE_BYTES: "33554432",
			},
		},
	});
	assert.ok(proxiedRequest);
	assert.equal(new URL(proxiedRequest.url).pathname, "/v1/execute");
	assert.equal(new URL(proxiedRequest.url).search, "?mode=test");
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(proxiedRequest.headers.get("x-client-header"), "kept");
	assert.deepEqual(await proxiedRequest.json(), { sql: "SELECT 1" });
});

void test("container startup failures return a controlled 503 response", async () => {
	let fetched = false;
	const response = await handleRequest(
		workspaceRequest(WORKSPACE_A, "/branches"),
		env({
			getByName: () => ({
				startAndWaitForPorts: async () => {
					throw new Error("Container failed to start");
				},
				fetch: async () => {
					fetched = true;
					return new Response("unexpected");
				},
			}),
		}),
		{ authenticate: authenticated(), authorizeWorkspace: allowed() },
	);

	assert.equal(response.status, 503);
	assert.equal(response.headers.get("retry-after"), "1");
	assert.equal(fetched, false);
	assert.deepEqual(await response.json(), {
		error: {
			code: "CONTAINER_UNAVAILABLE",
			message: "Workspace storage is temporarily unavailable.",
		},
	});
});

void test("two workspaces route to distinct containers", async () => {
	const names: Array<string> = [];
	const testEnv = env({
		getByName: (name) => {
			names.push(name);
			return { fetch: async () => new Response("ok") };
		},
	});
	for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
		const response = await handleRequest(
			workspaceRequest(workspaceId, "/branches"),
			testEnv,
			{
				authenticate: authenticated(),
				authorizeWorkspace: allowed(),
			},
		);
		assert.equal(response.status, 200);
	}
	assert.deepEqual(names, [WORKSPACE_A, WORKSPACE_B]);
});

void test("localhost E2E auth only authorizes its configured workspace", async () => {
	const testEnv = env({ extra: { LIXRAY_E2E_WORKSPACE_ID: E2E_WORKSPACE_ID } });
	const accepted = await handleRequest(
		new Request(`http://localhost/v1/workspaces/${E2E_WORKSPACE_ID}/branches`, {
			headers: { Authorization: `Bearer ${E2E_AUTH_TOKEN}` },
		}),
		testEnv,
	);
	assert.equal(accepted.status, 200);

	const deniedResponse = await handleRequest(
		new Request(`http://localhost/v1/workspaces/${WORKSPACE_A}/branches`, {
			headers: { Authorization: `Bearer ${E2E_AUTH_TOKEN}` },
		}),
		testEnv,
	);
	assert.equal(deniedResponse.status, 403);
});

void test("E2E auth is ignored outside localhost", async () => {
	const response = await authenticateWithSupabase(
		workspaceRequest(E2E_WORKSPACE_ID, "/branches", {
			headers: { Authorization: `Bearer ${E2E_AUTH_TOKEN}` },
		}),
		env({ extra: { LIXRAY_E2E_WORKSPACE_ID: E2E_WORKSPACE_ID } }),
	);
	assert.equal(response.ok, false);
	if (!response.ok) {
		assert.equal(response.response.status, 500);
		assert.equal(
			await response.response.text(),
			"SUPABASE_URL is not configured\n",
		);
	}
});

void test("Supabase workspace authorization uses the user token and RLS-visible row", async () => {
	const originalFetch = globalThis.fetch;
	let lookupUrl: URL | undefined;
	let lookupHeaders: Headers | undefined;
	globalThis.fetch = async (input, init) => {
		const requestUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		lookupUrl = new URL(requestUrl);
		lookupHeaders = new Headers(init?.headers);
		return Response.json([{ id: WORKSPACE_A }]);
	};
	try {
		const failure = await authorizeWorkspaceWithSupabase(
			WORKSPACE_A,
			{ userId: "user-123", token: "verified-user-token" },
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(failure, null);
		assert.equal(lookupUrl?.pathname, "/rest/v1/workspaces");
		assert.equal(lookupUrl?.searchParams.get("id"), `eq.${WORKSPACE_A}`);
		assert.equal(lookupHeaders?.get("apikey"), "publishable-key");
		assert.equal(
			lookupHeaders?.get("authorization"),
			"Bearer verified-user-token",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("Supabase workspace authorization hides absent or RLS-invisible rows", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json([]);
	try {
		const failure = await authorizeWorkspaceWithSupabase(
			WORKSPACE_A,
			{ userId: "user-123", token: "verified-user-token" },
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(failure?.status, 403);
		assert.equal(await failure?.text(), "Workspace access denied\n");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function workspaceRequest(
	workspaceId: string,
	endpoint: string,
	init?: RequestInit,
) {
	return new Request(
		`https://example.test/v1/workspaces/${workspaceId}${endpoint}`,
		init,
	);
}

function authenticated(): AuthenticateRequest {
	return async () => ({
		ok: true,
		auth: { userId: "user-123", token: "user-token" },
	});
}

function authenticatedMcp(): AuthenticateMcpRequest {
	return async () => ({
		ok: true,
		auth: {
			userId: "user-123",
			token: "oauth-user-token",
			clientId: "chatgpt-client",
		},
	});
}

function rejected(status: number, body: string): AuthenticateRequest {
	return async () => ({ ok: false, response: new Response(body, { status }) });
}

function allowed(): AuthorizeWorkspace {
	return async () => null;
}

function denied(): AuthorizeWorkspace {
	return async () => new Response("Workspace access denied\n", { status: 403 });
}

function env(options: {
	fetch?: (request: Request) => Promise<Response>;
	getByName?: WorkerEnv["SLATEDB_CONTAINER"]["getByName"];
	extra?: Partial<WorkerEnv>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}
