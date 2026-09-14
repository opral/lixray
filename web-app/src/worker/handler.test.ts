import { WorkerLixRuntimeClient } from "../mcp/runtime-client.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
	DEMO_AUTH_TOKEN,
	DEMO_ORGANIZATION_ID,
	DEMO_PROFILE_NAMESPACE_ID,
	demoProfileDocument,
	DEMO_ORGANIZATION_NAME,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
	DEMO_SECONDARY_LIX_ID,
	DEMO_SECONDARY_LIX_NAME,
} from "../lib/demo-identity.ts";
import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";
import { isLixError } from "../mcp/lix-service.ts";
import { SIGNUP_TELEMETRY_PATH } from "../lib/signup-telemetry.ts";
import {
	authenticateWithSupabase,
	authorizeLixWithSupabase,
	handleRequest,
	resolveLixWithSupabase,
	resolveCurrentAccount,
	resolveNamespaceMembershipWithSupabase,
	resolveNamespaceProfileWithSupabase,
	resolvePublicProfileRepositoriesWithSupabase,
	supabaseJwtIssuer,
	validateBrowserJwtClaims,
	validateMcpJwtClaims,
	type AuthenticateRequest,
	type AuthenticateMcpRequest,
	type RequestExecutionContext,
	type WorkerEnv,
} from "./handler.ts";
import {
	MCP_AI_PARENT_ID_HEADER,
	MCP_AI_SESSION_ID_HEADER,
	MCP_AI_TRACE_ID_HEADER,
	MCP_DOCUMENTATION_PATH,
	MCP_PATH,
	MCP_PROTECTED_RESOURCE_PATH,
	MCP_RESOURCE,
} from "../mcp/server.ts";
import { PublicProfileActivityCache } from "./profile-activity-cache.ts";

const LIX_A = "11111111-1111-4111-8111-111111111111";
const LIX_B = "22222222-2222-4222-8222-222222222222";
const NAMESPACE_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_DOCUMENT = {
	"@type": "Card",
	version: "2.0",
	kind: "individual",
	name: { full: "Samuel Stroschein" },
};

void test("GET /healthz returns Worker health without auth or proxying", async () => {
	const response = await handleRequest(
		new Request("https://example.test/healthz"),
		env({}),
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-railway-deployment-id"), null);
	assert.deepEqual(await response.json(), {
		ok: true,
		service: "lixray",
		deploymentId: null,
	});
});

void test("GET /healthz identifies the exact Railway deployment", async () => {
	const response = await handleRequest(
		new Request("https://example.test/healthz"),
		env({ extra: { RAILWAY_DEPLOYMENT_ID: "web-deployment-123" } }),
	);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("x-railway-deployment-id"),
		"web-deployment-123",
	);
	assert.deepEqual(await response.json(), {
		ok: true,
		service: "lixray",
		deploymentId: "web-deployment-123",
	});
});

void test("GET /.well-known/openai-apps-challenge returns the OpenAI verification token", async () => {
	const response = await handleRequest(
		new Request("https://example.test/.well-known/openai-apps-challenge"),
		env({}),
	);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("content-type"),
		"text/plain; charset=utf-8",
	);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(
		await response.text(),
		"RBTbX7uPYZwmyPGnWXM2eMruvkdC6MlM3Xsh95AqROU",
	);
});

void test("production email sign-in status is disabled outside production", async () => {
	const response = await handleRequest(
		new Request("https://example.test/auth/email"),
		env({
			extra: {
				RAILWAY_ENVIRONMENT_NAME: "lixray-pr-91",
			},
		}),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { enabled: false });
});

void test("production email sign-in status is enabled in production", async () => {
	const response = await handleRequest(
		new Request("https://example.test/auth/email"),
		env({
			extra: {
				RAILWAY_ENVIRONMENT_NAME: "production",
			},
		}),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		enabled: true,
		email: "dev@lixray.com",
	});
});

void test("production email sign-in exchanges a password through Supabase", async () => {
	let upstreamRequest: Request | null = null;
	let upstreamBody: BodyInit | null | undefined;
	const response = await handleRequest(
		new Request("https://example.test/auth/email", {
			method: "POST",
			headers: { origin: "https://example.test" },
			body: JSON.stringify({ password: "test-password" }),
		}),
		env({
			extra: {
				RAILWAY_ENVIRONMENT_NAME: "production",
				SUPABASE_URL: "https://project.supabase.co",
				SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			},
		}),
		{
			fetch: async (input, init) => {
				upstreamRequest = new Request(input, init);
				upstreamBody = init?.body;
				return Response.json({
					access_token: "access-token",
					refresh_token: "refresh-token",
				});
			},
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		access_token: "access-token",
		refresh_token: "refresh-token",
	});
	assert.equal(
		upstreamRequest?.url,
		"https://project.supabase.co/auth/v1/token?grant_type=password",
	);
	assert.equal(
		upstreamBody,
		JSON.stringify({ email: "dev@lixray.com", password: "test-password" }),
	);
});

void test("production email sign-in accepts the public origin behind a Railway host", async () => {
	const productionEnv = env({
		extra: {
			RAILWAY_ENVIRONMENT_NAME: "production",
			SUPABASE_URL: "https://project.supabase.co",
			SUPABASE_PUBLISHABLE_KEY: "publishable-key",
		},
	});
	const invalidCredentials = {
		error: "invalid_credentials",
		msg: "Invalid login credentials",
	};
	const cases: Array<{ url: string; headers: Record<string, string> }> = [
		{
			url: "https://web-production.up.railway.app/auth/email",
			headers: { origin: "https://lixray.com" },
		},
		{
			url: "http://web-production.up.railway.app/auth/email",
			headers: {
				origin: "https://lixray.com",
				"x-forwarded-host": "lixray.com",
				"x-forwarded-proto": "https",
			},
		},
	];

	for (const testCase of cases) {
		let reachedPasswordGrant = false;
		const response = await handleRequest(
			new Request(testCase.url, {
				method: "POST",
				headers: testCase.headers,
				body: JSON.stringify({ password: "wrong-password" }),
			}),
			productionEnv,
			{
				fetch: async () => {
					reachedPasswordGrant = true;
					return Response.json(invalidCredentials, { status: 400 });
				},
			},
		);
		assert.equal(response.status, 400, testCase.url);
		assert.equal(reachedPasswordGrant, true, testCase.url);
		assert.deepEqual(await response.json(), invalidCredentials);
	}
});

void test("production email sign-in rejects a cross-origin POST", async () => {
	let reachedPasswordGrant = false;
	const response = await handleRequest(
		new Request("https://web-production.up.railway.app/auth/email", {
			method: "POST",
			headers: {
				origin: "https://evil.example",
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			},
			body: JSON.stringify({ password: "test-password" }),
		}),
		env({
			extra: {
				RAILWAY_ENVIRONMENT_NAME: "production",
				SUPABASE_URL: "https://project.supabase.co",
				SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			},
		}),
		{
			fetch: async () => {
				reachedPasswordGrant = true;
				return Response.json({ access_token: "should-not-run" });
			},
		},
	);
	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Forbidden\n");
	assert.equal(reachedPasswordGrant, false);
});

void test("GET /profile/{namespace_id} serves a public JSContact profile", async () => {
	let resolvedNamespaceId: string | undefined;
	let fellBack = false;
	const response = await handleRequest(
		new Request(`https://example.test/profile/${NAMESPACE_ID}`),
		env({}),
		{
			resolveNamespaceProfile: async (namespaceId) => {
				resolvedNamespaceId = namespaceId;
				return {
					ok: true,
					document: PROFILE_DOCUMENT,
					updatedAt: "2026-08-21T12:00:00.000Z",
				};
			},
			fallback: async () => {
				fellBack = true;
				return new Response("frontend");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(resolvedNamespaceId, NAMESPACE_ID);
	assert.equal(fellBack, false);
	assert.equal(
		response.headers.get("content-type"),
		"application/jscontact+json; version=2.0",
	);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.match(response.headers.get("cache-control") ?? "", /max-age=3600/);
	assert.deepEqual(await response.json(), PROFILE_DOCUMENT);
});

void test("profile responses support HEAD and ETag revalidation", async () => {
	const resolveNamespaceProfile = async () => ({
		ok: true as const,
		document: PROFILE_DOCUMENT,
		updatedAt: "2026-08-21T12:00:00.000Z",
	});
	const first = await handleRequest(
		new Request(`https://example.test/profile/${NAMESPACE_ID}`, {
			method: "HEAD",
		}),
		env({}),
		{ resolveNamespaceProfile },
	);
	const etag = first.headers.get("etag");
	assert.equal(first.status, 200);
	assert.ok(etag);
	assert.equal(await first.text(), "");

	const revalidated = await handleRequest(
		new Request(`https://example.test/profile/${NAMESPACE_ID}`, {
			headers: { "If-None-Match": etag ?? "" },
		}),
		env({}),
		{ resolveNamespaceProfile },
	);
	assert.equal(revalidated.status, 304);
	assert.equal(await revalidated.text(), "");
});

void test("invalid profile IDs are rejected before profile resolution", async () => {
	let resolved = false;
	const response = await handleRequest(
		new Request("https://example.test/profile/not-a-uuid"),
		env({}),
		{
			resolveNamespaceProfile: async () => {
				resolved = true;
				return {
					ok: true,
					document: PROFILE_DOCUMENT,
					updatedAt: "2026-08-21T12:00:00.000Z",
				};
			},
		},
	);
	assert.equal(response.status, 404);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.equal(resolved, false);
});

void test("GET /profile/{namespace_id}/activity lists real public repositories", async () => {
	let resolvedNamespaceId: string | undefined;
	const response = await handleRequest(
		new Request(`https://example.test/profile/${NAMESPACE_ID}/activity`),
		env({}),
		{
			profileActivityCache: null,
			resolvePublicProfileRepositories: async (namespaceId) => {
				resolvedNamespaceId = namespaceId;
				return {
					ok: true,
					repositories: [
						{
							id: LIX_A,
							name: "Launch plan",
							slug: "launch-plan",
							namespaceHandle: "samuel",
						},
					],
				};
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(resolvedNamespaceId, NAMESPACE_ID);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.match(response.headers.get("cache-control") ?? "", /s-maxage=86400/);
	const activity = (await response.json()) as PublicProfileActivity;
	assert.equal(activity.totalFiles, 0);
	assert.equal(activity.failedRepositories, 1);
	assert.deepEqual(activity.repositories, [
		{
			id: LIX_A,
			name: "Launch plan",
			slug: "launch-plan",
			namespaceHandle: "samuel",
			fileCount: null,
		},
	]);
});

void test("profile activity queries file paths from every public Lix", async () => {
	const response = await handleRequest(
		new Request(`https://example.test/profile/${NAMESPACE_ID}/activity`),
		env({}),
		{
			profileActivityCache: null,
			resolvePublicProfileRepositories: async () => ({
				ok: true,
				repositories: [
					{
						id: LIX_A,
						name: "Launch plan",
						slug: "launch-plan",
						namespaceHandle: "samuel",
					},
				],
			}),
			lixFetch: async (lixId, request) => {
				assert.equal(lixId, LIX_A);
				const pathname = new URL(request.url).pathname;
				if (pathname === `/lix/v1/${LIX_A}/`) {
					return Response.json({
						protocolVersion: 9,
						activeBranchId: "main",
						activeAccountId: "00000000-0000-7000-8000-000000000002",
						sessionId: "profile-activity-session",
					});
				}
				if (
					pathname === `/lix/v1/${LIX_A}/session` &&
					request.method === "DELETE"
				) {
					return new Response(null, { status: 204 });
				}
				assert.equal(pathname, `/lix/v1/${LIX_A}/execute`);
				const body = (await request.json()) as { sql?: unknown };
				assert.equal(body.sql, "SELECT path FROM lix_file ORDER BY path");
				return Response.json({
					columns: [{ name: "path", type: "text" }],
					rows: [
						[{ kind: "text", value: "/README.md" }],
						[{ kind: "text", value: "/src/index.ts" }],
						[{ kind: "text", value: "/assets/logo.png" }],
					],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);

	assert.equal(response.status, 200);
	const activity = (await response.json()) as PublicProfileActivity;
	assert.equal(activity.totalFiles, 3);
	assert.equal(activity.failedRepositories, 0);
	assert.equal(activity.repositories[0].fileCount, 3);
	assert.deepEqual(
		activity.fileMix.map((segment) => segment.count),
		[1, 1, 0, 0, 1],
	);
});

void test("profile activity shares one repository scan across visitors", async () => {
	const cache = new PublicProfileActivityCache();
	let executeRequests = 0;
	const options = {
		profileActivityCache: cache,
		resolvePublicProfileRepositories: async () => ({
			ok: true as const,
			repositories: [
				{
					id: LIX_A,
					name: "Launch plan",
					slug: "launch-plan",
					namespaceHandle: "samuel",
				},
			],
		}),
		lixFetch: async (_lixId: string, request: Request) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === `/lix/v1/${LIX_A}/`) {
				return Response.json({
					protocolVersion: 9,
					activeBranchId: "main",
					activeAccountId: "00000000-0000-7000-8000-000000000002",
					sessionId: "profile-cache-session",
				});
			}
			if (
				pathname === `/lix/v1/${LIX_A}/session` &&
				request.method === "DELETE"
			) {
				return new Response(null, { status: 204 });
			}
			executeRequests += 1;
			return Response.json({
				columns: [{ name: "path", type: "text" }],
				rows: [[{ kind: "text", value: "/README.md" }]],
				rowsAffected: 0,
				notices: [],
			});
		},
	};

	const first = await handleRequest(
		new Request(`https://first-visitor.test/profile/${NAMESPACE_ID}/activity`),
		env({}),
		options,
	);
	const second = await handleRequest(
		new Request(`https://second-visitor.test/profile/${NAMESPACE_ID}/activity`),
		env({}),
		options,
	);

	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.equal(executeRequests, 1);
});

void test("public profile repository resolution calls the anonymous RPC", async () => {
	const originalFetch = globalThis.fetch;
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json([
			{
				namespace_id: NAMESPACE_ID,
				namespace_handle: "samuel",
				lix_id: LIX_A,
				lix_name: "Launch plan",
				lix_slug: "launch-plan",
				lix_updated_at: "2026-08-21T12:00:00.000Z",
			},
		]);
	};
	try {
		const resolution = await resolvePublicProfileRepositoriesWithSupabase(
			NAMESPACE_ID,
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(resolution.ok, true);
		assert.equal(
			request?.url,
			"https://project.supabase.co/rest/v1/rpc/list_public_profile_lixes",
		);
		assert.equal(request?.method, "POST");
		assert.equal(
			await request?.text(),
			JSON.stringify({ p_namespace_id: NAMESPACE_ID }),
		);
		if (resolution.ok) {
			assert.deepEqual(resolution.repositories, [
				{
					id: LIX_A,
					name: "Launch plan",
					slug: "launch-plan",
					namespaceHandle: "samuel",
				},
			]);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("signup telemetry authenticates and delegates one cross-surface event", async () => {
	let captured:
		| {
				userId: string;
				token: string;
				surface: string;
				source: string;
		  }
		| undefined;
	const response = await handleRequest(
		new Request("https://example.test/api/telemetry/signup", {
			method: "POST",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				surface: "mcp",
				source: "oauth",
			}),
		}),
		env({}),
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "user-id", token: "access-token" },
			}),
			captureSignup: async (_env, identity, context) => {
				captured = { ...identity, ...context };
				return "captured";
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { captured: true });
	assert.deepEqual(captured, {
		userId: "user-id",
		token: "access-token",
		surface: "mcp",
		source: "oauth",
	});
});

void test("signup telemetry rejects invalid surfaces before capture", async () => {
	let captureCalled = false;
	const response = await handleRequest(
		new Request("https://example.test/api/telemetry/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ surface: "browser", source: "direct" }),
		}),
		env({}),
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "user-id", token: "access-token" },
			}),
			captureSignup: async () => {
				captureCalled = true;
				return "captured";
			},
		},
	);
	assert.equal(response.status, 400);
	assert.equal(captureCalled, false);
});

void test("signup telemetry requires an authenticated browser session", async () => {
	const response = await handleRequest(
		new Request("https://example.test/api/telemetry/signup", {
			method: "POST",
			body: JSON.stringify({ surface: "web", source: "direct" }),
		}),
		env({}),
		{
			authenticate: async () => ({
				ok: false,
				response: new Response("Unauthorized\n", { status: 401 }),
			}),
		},
	);
	assert.equal(response.status, 401);
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
		env({
			extra: { SUPABASE_URL: "https://supabase.example.test" },
		}),
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
		authorization_servers: ["https://supabase.example.test/auth/v1"],
		scopes_supported: ["openid", "email", "profile", "offline_access"],
		resource_documentation: "https://lixray.com/mcp/docs",
	});
});

void test("localhost discovery isolates its OAuth resource from production", async () => {
	const response = await handleRequest(
		new Request(`http://localhost:8787${MCP_PROTECTED_RESOURCE_PATH}`),
		env({
			extra: { SUPABASE_URL: "http://127.0.0.1:54321" },
		}),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		resource: "http://localhost:8787",
		authorization_servers: ["http://127.0.0.1:54321/auth/v1"],
		scopes_supported: ["openid", "email", "profile", "offline_access"],
		resource_documentation: "http://localhost:8787/mcp/docs",
	});
});

void test("local MCP tokens cannot be replayed against production or another local origin", () => {
	const now = 1_700_000_000;
	const issuer = "http://127.0.0.1:54321/auth/v1";
	const localClaims = {
		sub: "user-123",
		role: "authenticated",
		aud: "authenticated",
		iss: issuer,
		exp: now + 300,
		client_id: "codex-local",
		resource: "http://127.0.0.1:8787",
		lixray_mcp: true,
		scope: "openid email profile offline_access",
	};

	assert.equal(
		validateMcpJwtClaims(localClaims, issuer, now, "http://127.0.0.1:8787").ok,
		true,
	);
	assert.equal(validateMcpJwtClaims(localClaims, issuer, now).ok, false);
	assert.equal(
		validateMcpJwtClaims(localClaims, issuer, now, "http://localhost:8787").ok,
		false,
	);
});

void test("unauthenticated localhost MCP requests challenge with local discovery", async () => {
	const response = await handleRequest(
		new Request("http://localhost:8787/mcp"),
		env({
			extra: {
				SUPABASE_URL: "http://127.0.0.1:54321",
				SUPABASE_JWKS_URL:
					"http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
			},
		}),
	);
	assert.equal(response.status, 401);
	assert.match(
		response.headers.get("www-authenticate") ?? "",
		/resource_metadata="http:\/\/localhost:8787\/\.well-known\/oauth-protected-resource"/,
	);
});

void test("MCP CORS permits end-to-end trace context headers", async () => {
	const response = await handleRequest(
		new Request(`https://example.test${MCP_PATH}`, { method: "OPTIONS" }),
		env({}),
	);
	assert.equal(response.status, 204);
	const allowed = response.headers.get("access-control-allow-headers") ?? "";
	assert.match(allowed, /Traceparent/i);
	assert.match(allowed, new RegExp(MCP_AI_TRACE_ID_HEADER, "i"));
	assert.match(allowed, new RegExp(MCP_AI_PARENT_ID_HEADER, "i"));
	assert.match(allowed, new RegExp(MCP_AI_SESSION_ID_HEADER, "i"));
});

void test("unauthenticated MCP tools/list returns an OAuth challenge", async () => {
	let reachedTransport = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			}),
		}),
		env({
			extra: {
				SUPABASE_URL: "https://project.supabase.co",
				SUPABASE_JWKS_URL:
					"https://project.supabase.co/auth/v1/.well-known/jwks.json",
			},
		}),
		{
			mcpTransport: async () => {
				reachedTransport = true;
				return new Response("unexpected");
			},
		},
	);
	assert.equal(response.status, 401);
	assert.equal(reachedTransport, false);
	assert.match(
		response.headers.get("www-authenticate") ?? "",
		/resource_metadata="https:\/\/lixray\.com\/\.well-known\/oauth-protected-resource"/,
	);
});

void test("unauthenticated MCP tools/call still returns an OAuth challenge", async () => {
	let reachedTransport = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_lixes", arguments: {} },
			}),
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
			mcpTransport: async () => {
				reachedTransport = true;
				return new Response("unexpected");
			},
		},
	);
	assert.equal(response.status, 401);
	assert.equal(reachedTransport, false);
	assert.match(
		response.headers.get("www-authenticate") ?? "",
		/resource_metadata="https:\/\/lixray\.com\/\.well-known\/oauth-protected-resource"/,
	);
});

void test("unauthenticated MCP initialize returns an OAuth challenge", async () => {
	let reachedTransport = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", {
			method: "POST",
			headers: {
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
		env({
			extra: {
				SUPABASE_URL: "https://project.supabase.co",
				SUPABASE_JWKS_URL:
					"https://project.supabase.co/auth/v1/.well-known/jwks.json",
			},
		}),
		{
			mcpTransport: async () => {
				reachedTransport = true;
				return new Response("unexpected");
			},
		},
	);
	assert.equal(response.status, 401);
	assert.equal(reachedTransport, false);
	assert.match(
		response.headers.get("www-authenticate") ?? "",
		/resource_metadata="https:\/\/lixray\.com\/\.well-known\/oauth-protected-resource"/,
	);
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
			lixFetch: async () => new Response("unused"),
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

void test("MCP reuses successful lix authorization only within one HTTP request", async () => {
	let authorizationChecks = 0;
	const protocolPaths: string[] = [];

	for (let request = 0; request < 2; request += 1) {
		const response = await handleRequest(
			new Request("https://example.test/mcp", { method: "POST" }),
			env({}),
			{
				authenticateMcp: authenticatedMcp(),
				authorizeLix: async (lixId) => {
					authorizationChecks += 1;
					assert.equal(lixId, LIX_A);
					return null;
				},
				lixFetch: mcpLixFetch(protocolPaths, "request-scoped-authorization"),
				lixSummaries: mcpLixSummaries(),
				mcpTransport: async (_request, service) => {
					const opened = await service.openLix(LIX_A);
					await service.executeBatch(opened.context, {
						statements: [{ sql: "SELECT 1" }, { sql: "SELECT 2" }],
					});
					return Response.json({ ok: true });
				},
			},
		);
		assert.equal(response.status, 200);
	}

	assert.equal(authorizationChecks, 2);
	assert.deepEqual(protocolPaths, [
		`/lix/v1/${LIX_A}/`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/execute`,
		"/lix/v1/11111111-1111-4111-8111-111111111111/execute-batch",
		`/lix/v1/${LIX_A}/session`,
		`/lix/v1/${LIX_A}/`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/execute`,
		"/lix/v1/11111111-1111-4111-8111-111111111111/execute-batch",
		`/lix/v1/${LIX_A}/session`,
	]);
});

void test("MCP keeps the runtime client alive until a streamed response is consumed", async () => {
	const protocolPaths: string[] = [];
	let lixCallCompleted = false;
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			authorizeLix: async () => null,
			lixFetch: mcpLixFetch(protocolPaths, "streaming-response"),
			lixSummaries: mcpLixSummaries(),
			mcpTransport: async (_request, service) => {
				const body = new ReadableStream<Uint8Array>({
					async pull(controller) {
						const opened = await service.openLix(LIX_A);
						await service.execute(opened.context, { sql: "SELECT 1" });
						lixCallCompleted = true;
						controller.enqueue(
							new TextEncoder().encode("event: done\\ndata: ok\\n\\n"),
						);
						controller.close();
					},
				});
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	);
	assert.equal(lixCallCompleted, false);
	assert.match(await response.text(), /event: done/);
	assert.equal(lixCallCompleted, true);
});

void test("MCP retries lix authorization after a denial", async () => {
	let authorizationChecks = 0;
	const protocolPaths: string[] = [];
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			authorizeLix: async () => {
				authorizationChecks += 1;
				return authorizationChecks === 1
					? new Response("Lix access denied", { status: 403 })
					: null;
			},
			lixFetch: mcpLixFetch(protocolPaths, "authorization-retry"),
			lixSummaries: mcpLixSummaries(),
			mcpTransport: async (_request, service) => {
				await assert.rejects(
					service.openLix(LIX_A),
					(error: unknown) => isLixError(error) && error.code === "not_found",
				);
				const opened = await service.openLix(LIX_A);
				await service.execute(opened.context, { sql: "SELECT 1" });
				return Response.json({ ok: true });
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(authorizationChecks, 2);
	assert.deepEqual(protocolPaths, [
		`/lix/v1/${LIX_A}/`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/session`,
	]);
});

void test("authenticated MCP telemetry receives identity and flushes through waitUntil", async () => {
	let waitedFor: Promise<unknown> | undefined;
	let flushes = 0;
	const observations: Array<unknown> = [];
	const executionContext = {
		waitUntil: (promise: Promise<unknown>) => {
			waitedFor = promise;
		},
		passThroughOnException: () => undefined,
		props: {},
	} as unknown as RequestExecutionContext;
	const testEnv = env({
		extra: {
			POSTHOG_PROJECT_TOKEN: "project-token",
			POSTHOG_HOST: "https://posthog.example",
			POSTHOG_ENVIRONMENT: "production",
		},
	});

	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		testEnv,
		{
			authenticateMcp: authenticatedMcp(),
			executionContext,
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: (telemetryEnv, identity) => {
				assert.equal(telemetryEnv.POSTHOG_PROJECT_TOKEN, "project-token");
				assert.deepEqual(identity, {
					userId: "user-123",
					clientId: "chatgpt-client",
					isDemo: undefined,
				});
				return {
					onToolCall: (observation) => observations.push(observation),
					flush: async () => {
						flushes += 1;
					},
				};
			},
			mcpTransport: async (_request, _service, options) => {
				assert.equal(options.posthogToken, "project-token");
				assert.equal(options.posthogHost, "https://posthog.example");
				assert.equal(options.posthogDistinctId, "user-123");
				assert.equal(options.posthogClientId, "chatgpt-client");
				options.onToolCall?.({
					requestId: options.requestId!,
					toolName: "list_lixes",
					outcome: "success",
					durationMs: 2,
				});
				return new Response("mcp response");
			},
		},
	);

	assert.equal(await response.text(), "mcp response");
	assert.deepEqual(observations, [
		{
			requestId: response.headers.get("x-request-id"),
			toolName: "list_lixes",
			outcome: "success",
			durationMs: 2,
		},
	]);
	assert.ok(waitedFor);
	await waitedFor;
	assert.equal(flushes, 1);
});

void test("official MCP PostHog token uses VITE_PUBLIC_POSTHOG_TOKEN when the project token is unset", async () => {
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({
			extra: {
				VITE_PUBLIC_POSTHOG_TOKEN: " phc_public_project_token ",
			},
		}),
		{
			authenticateMcp: authenticatedMcp(),
			createMcpTelemetry: () => null,
			lixFetch: async () => new Response("unused"),
			mcpTransport: async (_request, _service, options) => {
				assert.equal(options.posthogToken, "phc_public_project_token");
				assert.equal(options.posthogDistinctId, "user-123");
				assert.equal(typeof options.onPosthogFlush, "function");
				return new Response("mcp response");
			},
		},
	);

	assert.equal(await response.text(), "mcp response");
});

void test("official MCP PostHog token is passed when POSTHOG_ENVIRONMENT is unset", async () => {
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({
			extra: {
				POSTHOG_PROJECT_TOKEN: "project-token",
			},
		}),
		{
			authenticateMcp: authenticatedMcp(),
			createMcpTelemetry: () => null,
			lixFetch: async () => new Response("unused"),
			mcpTransport: async (_request, _service, options) => {
				assert.equal(options.posthogToken, "project-token");
				assert.equal(options.posthogDistinctId, "user-123");
				assert.equal(typeof options.onPosthogFlush, "function");
				return new Response("mcp response");
			},
		},
	);

	assert.equal(await response.text(), "mcp response");
});

void test("official MCP PostHog token is omitted in demo and Railway PR environments", async () => {
	for (const extra of [
		{
			LIXRAY_DEMO: "1",
			POSTHOG_PROJECT_TOKEN: "project-token",
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_project_token",
		},
		{
			RAILWAY_ENVIRONMENT_NAME: "lixray-pr-91",
			POSTHOG_PROJECT_TOKEN: "project-token",
		},
		{
			RAILWAY_ENVIRONMENT_NAME: "pr-11b179-85",
			VITE_PUBLIC_POSTHOG_TOKEN: "phc_public_project_token",
		},
	]) {
		const response = await handleRequest(
			new Request("https://example.test/mcp", { method: "POST" }),
			env({ extra }),
			{
				authenticateMcp: authenticatedMcp(),
				createMcpTelemetry: () => null,
				lixFetch: async () => new Response("unused"),
				mcpTransport: async (_request, _service, options) => {
					assert.equal(options.posthogToken, undefined, JSON.stringify(extra));
					assert.equal(options.onPosthogFlush, undefined);
					return new Response("mcp response");
				},
			},
		);
		assert.equal(await response.text(), "mcp response");
	}
});

void test("POSTHOG_API_KEY alone does not enable official MCP capture", async () => {
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({
			extra: {
				POSTHOG_API_KEY: "phx_personal_api_key",
			},
		}),
		{
			authenticateMcp: authenticatedMcp(),
			createMcpTelemetry: () => null,
			lixFetch: async () => new Response("unused"),
			mcpTransport: async (_request, _service, options) => {
				assert.equal(options.posthogToken, undefined);
				assert.equal(options.onPosthogFlush, undefined);
				return new Response("mcp response");
			},
		},
	);

	assert.equal(await response.text(), "mcp response");
});

void test("Lixr MCP telemetry captures file writes and import completion", async () => {
	const executionContext = {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		props: {},
	} as unknown as RequestExecutionContext;

	const response = await handleRequest(
		new Request("https://lixr.com/mcp", { method: "POST" }),
		env({
			extra: {
				POSTHOG_PROJECT_TOKEN: "project-token",
				POSTHOG_HOST: "https://posthog.example",
				POSTHOG_ENVIRONMENT: "production",
			},
		}),
		{
			authenticateMcp: authenticatedMcp(),
			executionContext,
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: () => ({
				onToolCall: () => undefined,
				flush: async () => undefined,
			}),
			mcpTransport: async (_request, _service, options) => {
				options.onToolCall?.({
					requestId: options.requestId!,
					toolName: "execute_sql",
					outcome: "success",
					durationMs: 15,
					surfaceVersion: "v1",
					lixId: "lix-123",
					rawStatements: [
						{
							sql: "INSERT INTO lix_file (id, path, content) VALUES ($1, $2, $3)",
							params: [
								{ kind: "text", value: "file-1" },
								{ kind: "text", value: "/skills/hello.md" },
								{
									kind: "text",
									value: "# Hello\n\nImported markdown for onboarding.",
								},
							],
						},
					],
					executeInput: {
						statementCount: 1,
						statements: [
							{
								operation: "INSERT",
								sanitizedSql: "INSERT INTO lix_file VALUES (?, ?, ?)",
								shapeId: "shape1",
							},
						],
					},
					executeOutput: {
						resultCount: 1,
						rowCount: 1,
						rowsAffected: 1,
						noticeCodes: [],
						results: [
							{
								columnCount: 0,
								rowCount: 1,
								rowsAffected: 1,
								noticeCodes: [],
							},
						],
					},
				});
				return new Response("mcp response");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "mcp response");
});

void test("failed then successful MCP executes share identity and flush", async () => {
	const observations: Array<{
		requestId: string;
		outcome: string;
		errorCode?: string;
		lixId?: string;
	}> = [];
	let flushes = 0;
	const executionContext = {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		props: {},
	} as unknown as RequestExecutionContext;

	const failId = "3d7be30b-24a7-4ae6-8694-28e35b803b43";
	const successId = "82db8877-4cc3-42a3-b291-76a23a9b3ac6";
	const response = await handleRequest(
		new Request("https://lixray.com/mcp", { method: "POST" }),
		env({
			extra: {
				POSTHOG_PROJECT_TOKEN: "project-token",
				POSTHOG_ENVIRONMENT: "production",
			},
		}),
		{
			authenticateMcp: authenticatedMcp(),
			executionContext,
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: () => ({
				onToolCall: (observation) => {
					observations.push({
						requestId: observation.requestId,
						outcome: observation.outcome,
						errorCode: observation.errorCode,
						lixId: observation.lixId,
					});
				},
				flush: async () => {
					flushes += 1;
				},
			}),
			mcpTransport: async (_request, _service, options) => {
				options.onToolCall?.({
					requestId: failId,
					toolName: "execute_sql",
					outcome: "error",
					durationMs: 8,
					surfaceVersion: "v1",
					errorCode: "LIX_TYPE_MISMATCH",
					lixId: "lix-123",
					executeInput: {
						statementCount: 1,
						statements: [
							{
								operation: "INSERT",
								sanitizedSql: "insert into lix_file(path,content)values(?,?)",
								shapeId: "shape1",
							},
						],
					},
				});
				options.onToolCall?.({
					requestId: successId,
					toolName: "execute_sql",
					outcome: "success",
					durationMs: 11,
					surfaceVersion: "v1",
					lixId: "lix-123",
					executeInput: {
						statementCount: 1,
						statements: [
							{
								operation: "INSERT",
								sanitizedSql: "insert into lix_file(path,content)values(?,?)",
								shapeId: "shape1",
							},
						],
					},
					executeOutput: {
						resultCount: 1,
						rowCount: 0,
						rowsAffected: 1,
						noticeCodes: [],
						results: [],
					},
				});
				return new Response("mcp response");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(observations, [
		{
			requestId: failId,
			outcome: "error",
			errorCode: "LIX_TYPE_MISMATCH",
			lixId: "lix-123",
		},
		{
			requestId: successId,
			outcome: "success",
			errorCode: undefined,
			lixId: "lix-123",
		},
	]);
	assert.notEqual(observations[0]?.requestId, observations[1]?.requestId);
	assert.equal(flushes, 1);
});

void test("successful exact-Lix MCP activity is persisted before the response completes", async () => {
	const records: Array<{
		lixId: string | undefined;
		toolName: string;
		userId: string;
		clientId: string;
	}> = [];
	let releaseRecord: (() => void) | undefined;
	const recordBlocked = new Promise<void>((resolve) => {
		releaseRecord = resolve;
	});

	const responsePromise = handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			lixFetch: async () => new Response("unused"),
			recordMcpLixConnection: async (observation, auth) => {
				records.push({
					lixId: observation.lixId,
					toolName: observation.toolName,
					userId: auth.userId,
					clientId: auth.clientId,
				});
				await recordBlocked;
			},
			mcpTransport: async (_request, _service, options) => {
				options.onToolCall?.({
					requestId: options.requestId!,
					toolName: "active_branch_id",
					outcome: "success",
					durationMs: 2,
					surfaceVersion: "test",
					lixId: LIX_A,
				});
				options.onToolCall?.({
					requestId: options.requestId!,
					toolName: "list_lixes",
					outcome: "success",
					durationMs: 1,
					surfaceVersion: "test",
				});
				options.onToolCall?.({
					requestId: options.requestId!,
					toolName: "query_sql",
					outcome: "error",
					durationMs: 1,
					surfaceVersion: "test",
					lixId: LIX_A,
				});
				return new Response("connected");
			},
		},
	);

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(records, [
		{
			lixId: LIX_A,
			toolName: "active_branch_id",
			userId: "user-123",
			clientId: "chatgpt-client",
		},
	]);

	let responseSettled = false;
	void responsePromise.then(() => {
		responseSettled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(responseSettled, false);

	releaseRecord?.();
	const response = await responsePromise;
	assert.equal(await response.text(), "connected");
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
		scope: "openid email profile offline_access",
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

void test("JWT validation can use a public Supabase issuer separate from its private API URL", () => {
	assert.equal(
		supabaseJwtIssuer({
			SUPABASE_URL: "http://host.docker.internal:54321",
			SUPABASE_JWT_ISSUER_URL: "http://127.0.0.1:54321/",
		}),
		"http://127.0.0.1:54321/auth/v1",
	);
	assert.equal(
		supabaseJwtIssuer({
			SUPABASE_URL: "https://project.supabase.co/",
		}),
		"https://project.supabase.co/auth/v1",
	);
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

void test("remote sync CORS permits protocol, session, and chunk headers", async () => {
	const response = await handleRequest(
		remoteLixRequest("/sync/chunk", {
			method: "OPTIONS",
			headers: { origin: "https://atelier-preview.test" },
		}),
		env({}),
	);

	assert.equal(response.status, 204);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"https://atelier-preview.test",
	);
	assert.match(
		response.headers.get("access-control-allow-methods") ?? "",
		/PUT/,
	);
	const allowedHeaders =
		response.headers.get("access-control-allow-headers") ?? "";
	assert.match(allowedHeaders, /Lix-Session-Id/i);
	assert.match(allowedHeaders, /Lix-Server-Protocol-Version/i);
	assert.match(allowedHeaders, /Lix-Sync-Protocol-Version/i);
	assert.match(allowedHeaders, /Idempotency-Key/i);
	assert.match(allowedHeaders, /Lix-Transaction-Id/i);
	assert.match(allowedHeaders, /Content-Encoding/i);
	assert.match(allowedHeaders, /Content-Range/i);
	assert.match(allowedHeaders, /Lix-Upload-Id/i);
});

void test("canonical Lix protocol is authenticated, resolved, and forwarded unchanged", async () => {
	const body = {
		statements: [{ sql: "SELECT $1", params: [{ kind: "int", value: 1 }] }],
	};
	let proxiedRequest: Request | undefined;
	const upstreamBody = [
		{
			columns: [{ name: "value", type: "integer" }],
			rows: [],
			rowsAffected: 0,
			notices: [],
		},
	];
	const upstream = Response.json(upstreamBody, {
		headers: { "Server-Timing": "lix-server-protocol;dur=1.250" },
	});
	const response = await handleRequest(
		new Request(
			"https://example.test/lix/v1/11111111-1111-4111-8111-111111111111/execute-batch",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer user-token",
					origin: "https://atelier-preview.test",
					"content-type": "application/json",
					"Lix-Session-Id": "server-issued-session",
					"Idempotency-Key": "client-retry-key",
					"X-Lixray-Idempotency-Principal": "forged-client-principal",
				},
				body: JSON.stringify(body),
			},
		),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: async (lixId, auth) => {
				assert.equal(lixId, LIX_A);
				assert.equal(auth.userId, "user-123");
				return null;
			},
			lixFetch: async (lixId, request) => {
				assert.equal(lixId, LIX_A);
				proxiedRequest = request;
				return upstream;
			},
		},
	);

	assert.deepEqual(await response.json(), upstreamBody);
	const serverTiming = response.headers.get("server-timing") ?? "";
	assert.match(serverTiming, /lix-server-protocol;dur=1\.250/);
	assert.match(serverTiming, /lixray-web-auth;dur=\d+\.\d{3}/);
	assert.match(serverTiming, /lixray-web-resolve;dur=\d+\.\d{3}/);
	assert.match(serverTiming, /lixray-server-roundtrip;dur=\d+\.\d{3}/);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"https://atelier-preview.test",
	);
	assert.equal(
		response.headers.get("access-control-allow-credentials"),
		"true",
	);
	assert.match(response.headers.get("vary") ?? "", /Origin/);
	assert.ok(proxiedRequest);
	assert.equal(
		new URL(proxiedRequest.url).pathname,
		"/lix/v1/11111111-1111-4111-8111-111111111111/execute-batch",
	);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(
		proxiedRequest.headers.get("lix-session-id"),
		"server-issued-session",
	);
	assert.equal(
		proxiedRequest.headers.get("idempotency-key"),
		"client-retry-key",
	);
	assert.equal(
		proxiedRequest.headers.get("x-lixray-idempotency-principal"),
		"user-123",
	);
	assert.deepEqual(await proxiedRequest.json(), body);
});

void test("authenticated handshake provisions the canonical account profile", async () => {
	const account = {
		id: "01920000-0000-7000-8000-000000000601",
		kind: "human",
		name: "Example Account",
		profileUri:
			"https://lixray.com/profile/11111111-1111-4111-8111-111111111111",
	};
	const requests: Request[] = [];
	const response = await handleRequest(
		remoteLixRequest("/", {
			headers: { Authorization: "Bearer user-token" },
		}),
		env({}),
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: account.id, token: "user-token", account },
			}),
			authorizeLix: resolved(LIX_A),
			lixFetch: async (_lixId, request) => {
				requests.push(request);
				if (new URL(request.url).pathname === `/lix/v1/${LIX_A}/`) {
					return Response.json({
						activeAccountId: account.id,
						sessionId: "session-1",
					});
				}
				const { sql } = (await request.clone().json()) as { sql: string };
				if (sql.startsWith("SELECT")) {
					return Response.json({
						rows: [
							[
								{ kind: "text", value: account.id },
								{ kind: "text", value: account.kind },
								{ kind: "null", value: null },
							],
						],
					});
				}
				return Response.json({ rowsAffected: 1 });
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(requests.length, 3);
	assert.deepEqual(
		requests.map((request) => new URL(request.url).pathname),
		[
			`/lix/v1/${LIX_A}/`,
			`/lix/v1/${LIX_A}/execute`,
			`/lix/v1/${LIX_A}/execute`,
		],
	);
	for (const request of requests) {
		assert.equal(
			request.headers.get("x-lixray-idempotency-principal"),
			account.id,
		);
	}
});

void test("snapshot export uses the authenticated canonical protocol route", async () => {
	let proxiedRequest: Request | undefined;
	const response = await handleRequest(
		remoteLixRequest("/snapshot", {
			headers: { Authorization: "Bearer user-token" },
		}),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: resolved(LIX_A),
			lixFetch: async (_lixId, request) => {
				proxiedRequest = request;
				return new Response(new Uint8Array([0x4c, 0x49, 0x58]), {
					headers: {
						"content-type": "application/vnd.lix.snapshot",
						"cache-control": "no-store, no-transform",
					},
				});
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("content-type"),
		"application/vnd.lix.snapshot",
	);
	assert.ok(proxiedRequest);
	assert.equal(
		new URL(proxiedRequest.url).pathname,
		`/lix/v1/${LIX_A}/snapshot`,
	);
});

void test("anonymous snapshot export is rejected before public resolution", async () => {
	let publicLookups = 0;
	let proxied = false;
	const response = await handleRequest(remoteLixRequest("/snapshot"), env({}), {
		resolvePublicLix: async () => {
			publicLookups += 1;
			return { ok: true, lixId: LIX_A };
		},
		lixFetch: async () => {
			proxied = true;
			return new Response("unexpected");
		},
	});
	assert.equal(response.status, 401);
	assert.equal(publicLookups, 0);
	assert.equal(proxied, false);
});

void test("removed lix sidecar routes return 404 before auth", async () => {
	const response = await handleRequest(
		new Request("https://example.test/v1/lixes/not-a-uuid/filesystem/mutate"),
		env({}),
		{
			authenticate: async () => {
				throw new Error("auth should not run");
			},
		},
	);
	assert.equal(response.status, 404);
	assert.equal(await response.text(), "Not found\n");
});

void test("canonical mutation routes return authentication failures", async () => {
	const response = await handleRequest(
		remoteLixRequest("/branch/switch", {
			method: "POST",
			headers: { Authorization: "Bearer invalid-user-token" },
		}),
		env({}),
		{
			authenticate: rejected(401, "Unauthorized\n"),
		},
	);
	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
});

void test("invalid bearer tokens do not fall through to public reads", async () => {
	let publicLixLookups = 0;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: {
				Authorization: "Bearer expired-user-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ sql: "SELECT 1" }),
		}),
		env({}),
		{
			authenticate: rejected(401, "Unauthorized\n"),
			resolvePublicLix: async () => {
				publicLixLookups += 1;
				return { ok: true, lixId: LIX_A };
			},
		},
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
	assert.equal(publicLixLookups, 0);
	const serverTiming = response.headers.get("server-timing") ?? "";
	assert.match(serverTiming, /lixray-web-auth;dur=\d+\.\d{3}/);
	assert.doesNotMatch(serverTiming, /lixray-web-resolve/);
	assert.doesNotMatch(serverTiming, /lixray-server-roundtrip/);
});

void test("inaccessible lixes return 403 from mutation routes", async () => {
	const response = await handleRequest(
		remoteLixRequest("/branch/switch", {
			method: "POST",
			headers: { Authorization: "Bearer user-token" },
		}),
		env({}),
		{ authenticate: authenticated(), authorizeLix: unresolved(403) },
	);
	assert.equal(response.status, 403);
});

void test("anonymous public reads resolve publicly and forward without auth", async () => {
	let proxiedRequest: Request | undefined;
	let publicLixLookups = 0;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "SELECT path FROM lix_file" }),
		}),
		env({}),
		{
			authenticate: async () => {
				throw new Error("anonymous reads must not authenticate first");
			},
			resolvePublicLix: async (lixId) => {
				publicLixLookups += 1;
				assert.equal(lixId, LIX_A);
				return { ok: true, lixId: LIX_A };
			},
			lixFetch: async (lixId, request) => {
				assert.equal(lixId, LIX_A);
				proxiedRequest = request;
				return new Response("public read");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "public read");
	assert.equal(publicLixLookups, 1);
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(
		proxiedRequest.headers.get("x-lixray-idempotency-principal"),
		null,
	);
	assert.deepEqual(await proxiedRequest.json(), {
		sql: "SELECT path FROM lix_file",
	});
});

for (const endpoint of [
	"/admission",
	"/sync/pull?limit=512",
	"/sync/history?commitId=commit-1",
	"/sync/blob?blobId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	"/sync/chunk?chunkId=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
]) {
	void test(`anonymous public sync read ${endpoint} forwards without auth`, async () => {
		let proxiedRequest: Request | undefined;
		const response = await handleRequest(
			remoteLixRequest(endpoint, { method: "GET" }),
			env({}),
			{
				authenticate: async () => {
					throw new Error("anonymous sync reads must not authenticate first");
				},
				resolvePublicLix: async () => ({ ok: true, lixId: LIX_A }),
				lixFetch: async (_lixId, request) => {
					proxiedRequest = request;
					return Response.json({ ok: true });
				},
			},
		);

		assert.equal(response.status, 200);
		assert.ok(proxiedRequest);
		assert.equal(proxiedRequest.method, "GET");
		assert.equal(proxiedRequest.headers.get("authorization"), null);
		assert.equal(
			new URL(proxiedRequest.url).pathname,
			`/lix/v1/${LIX_A}${endpoint.split("?")[0]}`,
		);
	});
}

for (const [endpoint, method] of [
	["/sync/push", "POST"],
	["/sync/blob", "POST"],
	[
		"/sync/chunk?chunkId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"PUT",
	],
] as const) {
	void test(`anonymous sync mutation ${method} ${endpoint} remains unauthorized`, async () => {
		let publicLixLookedUp = false;
		let proxied = false;
		const response = await handleRequest(
			remoteLixRequest(endpoint, { method }),
			env({}),
			{
				resolvePublicLix: async () => {
					publicLixLookedUp = true;
					return { ok: true, lixId: LIX_A };
				},
				lixFetch: async () => {
					proxied = true;
					return new Response("unexpected");
				},
			},
		);

		assert.equal(response.status, 401);
		assert.equal(publicLixLookedUp, false);
		assert.equal(proxied, false);
	});
}

void test("anonymous public binary file reads forward without SQL parsing", async () => {
	let proxiedRequest: Request | undefined;
	const response = await handleRequest(
		remoteLixRequest("/file?path=%2Fassets%2Freport.pdf", {
			method: "GET",
			headers: { "Lix-Session-Id": "public-reader-session" },
		}),
		env({}),
		{
			authenticate: async () => {
				throw new Error("anonymous reads must not authenticate first");
			},
			resolvePublicLix: async () => ({ ok: true, lixId: LIX_A }),
			lixFetch: async (_lixId, request) => {
				proxiedRequest = request;
				return new Response(new Uint8Array([0, 1, 2, 255]), {
					headers: {
						"cache-control": "no-store",
						"content-type": "application/octet-stream",
						"lix-file-found": "true",
					},
				});
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(
		[...new Uint8Array(await response.arrayBuffer())],
		[0, 1, 2, 255],
	);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.ok(proxiedRequest);
	const proxiedUrl = new URL(proxiedRequest.url);
	assert.equal(proxiedUrl.pathname, `/lix/v1/${LIX_A}/file`);
	assert.equal(proxiedUrl.search, "?path=%2Fassets%2Freport.pdf");
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(
		proxiedRequest.headers.get("lix-session-id"),
		"public-reader-session",
	);
});

void test("a published file resolves by path without exposing private SQL", async () => {
	const originalFetch = globalThis.fetch;
	let lookupBody: unknown;
	let proxied = 0;
	globalThis.fetch = async (_input, init) => {
		assert.equal(typeof init?.body, "string");
		if (typeof init?.body !== "string") {
			throw new TypeError("Expected a JSON request body");
		}
		lookupBody = JSON.parse(init.body) as unknown;
		return Response.json([
			{
				lix_id: LIX_A,
				visibility: "private",
				path_public: true,
			},
		]);
	};
	try {
		const fileResponse = await handleRequest(
			remoteLixRequest("/file?path=%2Ffinance%2Fq1.pdf"),
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
			{
				lixFetch: async () => {
					proxied += 1;
					return new Response("published file");
				},
			},
		);
		assert.equal(fileResponse.status, 200);
		assert.equal(await fileResponse.text(), "published file");
		assert.deepEqual(lookupBody, {
			p_lix_id: LIX_A,
			p_path: "/finance/q1.pdf",
		});

		const sqlResponse = await handleRequest(
			remoteLixRequest("/execute", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-lixray-public-path": "/finance/q1.pdf",
				},
				body: JSON.stringify({ sql: "SELECT * FROM lix_file" }),
			}),
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
			{
				lixFetch: async () => {
					proxied += 1;
					return new Response("private rows leaked");
				},
			},
		);
		assert.equal(sqlResponse.status, 404);
		assert.equal(proxied, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("a published directory exposes only its direct child names", async () => {
	const protocolPaths: string[] = [];
	let executeBody: unknown;
	const response = await handleRequest(
		new Request(
			`https://example.test/api/published/lix/${LIX_A}/directory?path=%2Ffinance`,
		),
		env({}),
		{
			resolvePublicLix: async (lixId, _env, publicPath) => {
				assert.equal(lixId, LIX_A);
				assert.equal(publicPath, "/finance");
				return { ok: true, lixId: LIX_A, scope: "path" };
			},
			lixFetch: async (lixId, request) => {
				assert.equal(lixId, LIX_A);
				assert.equal(
					request.headers.get("x-lixray-idempotency-principal"),
					"00000000-0000-7000-8000-000000000002",
				);
				const path = new URL(request.url).pathname;
				protocolPaths.push(path);
				if (path === `/lix/v1/${LIX_A}/`) {
					return Response.json({
						protocolVersion: 9,
						activeBranchId: "main",
						activeAccountId: "00000000-0000-7000-8000-000000000002",
						sessionId: "published-directory-session",
					});
				}
				if (path === `/lix/v1/${LIX_A}/session`) {
					assert.equal(request.method, "DELETE");
					return new Response(null, { status: 204 });
				}
				assert.equal(path, `/lix/v1/${LIX_A}/execute`);
				executeBody = await request.json();
				return Response.json({
					columns: [
						{ name: "id", type: "text" },
						{ name: "path", type: "text" },
						{ name: "kind", type: "text" },
					],
					rows: [
						[
							{ kind: "text", value: LIX_A },
							{ kind: "text", value: "/finance/budget.csv" },
							{ kind: "text", value: "file" },
						],
						[
							{ kind: "text", value: LIX_B },
							{ kind: "text", value: "/finance/reports" },
							{ kind: "text", value: "directory" },
						],
					],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		entries: [
			{ id: LIX_A, path: "/finance/budget.csv", kind: "file" },
			{ id: LIX_B, path: "/finance/reports", kind: "directory" },
		],
		truncated: false,
	});
	assert.ok(isRecord(executeBody));
	assert.match(String(executeBody.sql), /FROM lix_file/);
	assert.match(String(executeBody.sql), /FROM lix_directory/);
	assert.deepEqual(executeBody.params, [{ kind: "text", value: "/finance" }]);
	assert.deepEqual(protocolPaths, [
		`/lix/v1/${LIX_A}/`,
		`/lix/v1/${LIX_A}/execute`,
		`/lix/v1/${LIX_A}/session`,
	]);
});

void test("a public repository can list a directory through the host projection", async () => {
	const response = await handleRequest(
		new Request(
			`https://example.test/api/published/lix/${LIX_A}/directory?path=%2Ffinance`,
		),
		env({}),
		{
			resolvePublicLix: async () => ({
				ok: true,
				lixId: LIX_A,
				scope: "repository",
			}),
			lixFetch: async (_lixId, request) => {
				const path = new URL(request.url).pathname;
				if (path === `/lix/v1/${LIX_A}/`) {
					return Response.json({
						protocolVersion: 9,
						activeBranchId: "main",
						activeAccountId: "00000000-0000-7000-8000-000000000002",
						sessionId: "public-directory-session",
					});
				}
				if (path === `/lix/v1/${LIX_A}/session`) {
					return new Response(null, { status: 204 });
				}
				return Response.json({
					columns: [
						{ name: "id", type: "text" },
						{ name: "path", type: "text" },
						{ name: "kind", type: "text" },
					],
					rows: [],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { entries: [], truncated: false });
});

void test("canonical file metadata is exposed to cross-origin SDK clients", async () => {
	const response = await handleRequest(
		remoteLixRequest("/file?path=%2Fempty.txt", {
			headers: {
				Authorization: "Bearer user-token",
				origin: "https://atelier-preview.test",
			},
		}),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: resolved(LIX_A),
			lixFetch: async () =>
				new Response(new Uint8Array(), {
					headers: {
						"Accept-Ranges": "bytes",
						"Content-Range": "bytes 0-0/1",
						"Lix-File-Found": "true",
						Range: "bytes=0-0",
					},
				}),
		},
	);

	const exposedHeaders =
		response.headers.get("access-control-expose-headers") ?? "";
	for (const headerName of [
		"Accept-Ranges",
		"Content-Range",
		"Lix-File-Found",
		"Range",
	]) {
		assert.match(exposedHeaders, new RegExp(headerName, "i"));
	}
	assert.equal(response.headers.get("accept-ranges"), "bytes");
	assert.equal(response.headers.get("content-range"), "bytes 0-0/1");
	assert.equal(response.headers.get("lix-file-found"), "true");
	assert.equal(response.headers.get("range"), "bytes=0-0");
});

void test("LixRay projections stay outside the canonical Lix namespace", async () => {
	let proxiedPath: string | undefined;
	let publicResolutionCalls = 0;
	const response = await handleRequest(
		remoteLixRequest("/published-directory?path=%2Ffinance", {
			headers: { Authorization: "Bearer user-token" },
		}),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: resolved(LIX_A),
			resolvePublicLix: async () => {
				publicResolutionCalls += 1;
				return { ok: true, lixId: LIX_A, scope: "path" };
			},
			lixFetch: async (_lixId, request) => {
				proxiedPath = new URL(request.url).pathname;
				return new Response("Not found\n", { status: 404 });
			},
		},
	);

	assert.equal(response.status, 404);
	assert.equal(proxiedPath, `/lix/v1/${LIX_A}/published-directory`);
	assert.equal(publicResolutionCalls, 0);
});

void test("anonymous binary file writes remain unauthorized", async () => {
	let publicLixLookedUp = false;
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/file/upsert", {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: "not-a-public-write",
		}),
		env({}),
		{
			resolvePublicLix: async () => {
				publicLixLookedUp = true;
				return { ok: true, lixId: LIX_A };
			},
			lixFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 401);
	assert.equal(publicLixLookedUp, false);
	assert.equal(proxied, false);
	assert.match(
		response.headers.get("server-timing") ?? "",
		/lixray-web-auth;dur=\d+\.\d{3}/,
	);
});

void test("anonymous public readers can release their opaque remote session", async () => {
	let proxiedRequest: Request | undefined;
	const response = await handleRequest(
		remoteLixRequest("/session", {
			method: "DELETE",
			headers: { "Lix-Session-Id": "public-reader-session" },
		}),
		env({}),
		{
			resolvePublicLix: async () => ({
				ok: true,
				lixId: LIX_A,
			}),
			lixFetch: async (_lixId, request) => {
				proxiedRequest = request;
				return new Response(null, { status: 204 });
			},
		},
	);

	assert.equal(response.status, 204);
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.method, "DELETE");
	assert.equal(
		proxiedRequest.headers.get("lix-session-id"),
		"public-reader-session",
	);
});

void test("anonymous branch mutations remain unauthorized", async () => {
	let publicLixLookedUp = false;
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/branch/switch", { method: "POST" }),
		env({}),
		{
			authenticate: async () => {
				throw new Error("anonymous unsafe requests must not authenticate");
			},
			resolvePublicLix: async () => {
				publicLixLookedUp = true;
				return { ok: true, lixId: LIX_A };
			},
			lixFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
	assert.equal(publicLixLookedUp, false);
	assert.equal(proxied, false);
});

void test("public write SQL is rejected before it reaches the lix", async () => {
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "DELETE FROM lix_file" }),
		}),
		env({}),
		{
			resolvePublicLix: async () => ({
				ok: true,
				lixId: LIX_A,
			}),
			lixFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: { code: "LIX_READ_ONLY", message: "lix is read-only" },
	});
	assert.equal(proxied, false);
});

void test("a mutation cannot hide behind a multi-statement public script", async () => {
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "SELECT 1; DELETE FROM lix_file" }),
		}),
		env({}),
		{
			resolvePublicLix: async () => ({
				ok: true,
				lixId: LIX_A,
			}),
			lixFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 400);
	assert.equal(proxied, false);
});

void test("public reads classify writes without a SQL parser", async () => {
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "SELECT 1" }),
		}),
		env({}),
		{
			resolvePublicLix: async () => ({
				ok: true,
				lixId: LIX_A,
			}),
			lixFetch: async () => {
				proxied = true;
				return new Response("public read");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "public read");
	assert.equal(proxied, true);
});

void test("authenticated non-members are downgraded to the public read transport", async () => {
	let proxiedRequest: Request | undefined;
	let publicLixLookups = 0;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: {
				Authorization: "Bearer non-member-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ sql: "SELECT 1" }),
		}),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: unresolved(403),
			resolvePublicLix: async () => {
				publicLixLookups += 1;
				return { ok: true, lixId: LIX_A };
			},
			lixFetch: async (_lixId, request) => {
				proxiedRequest = request;
				return new Response("downgraded");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "downgraded");
	assert.equal(publicLixLookups, 1);
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
});

void test("authenticated repository members can proxy a write request", async () => {
	let proxiedRequest: Request | undefined;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: {
				Authorization: "Bearer invited-member-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ sql: "DELETE FROM lix_file" }),
		}),
		env({}),
		{
			authenticate: authenticated(),
			authorizeLix: resolved(LIX_A),
			resolvePublicLix: async () => {
				throw new Error("members must not use the public read transport");
			},
			lixFetch: async (_lixId, request) => {
				proxiedRequest = request;
				return new Response("written");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "written");
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.deepEqual(await proxiedRequest.json(), {
		sql: "DELETE FROM lix_file",
	});
});

void test("authorized requests route by lix, rewrite paths, preserve bodies and strip auth", async () => {
	let proxiedRequest: Request | undefined;
	const request = remoteLixRequest("/observe?mode=test", {
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
			extra: {
				POSTHOG_PROJECT_TOKEN: "project-token",
				POSTHOG_HOST: "https://posthog.example",
				POSTHOG_ENVIRONMENT: "production",
			},
		}),
		{
			authenticate: authenticated(),
			authorizeLix: resolved(LIX_A),
			lixFetch: async (lixId, incoming) => {
				assert.equal(lixId, LIX_A);
				proxiedRequest = incoming;
				return new Response("event: next\ndata: {}\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	);

	assert.equal(response.headers.get("content-type"), "text/event-stream");
	assert.ok(proxiedRequest);
	assert.equal(
		new URL(proxiedRequest.url).pathname,
		`/lix/v1/${LIX_A}/observe`,
	);
	assert.equal(new URL(proxiedRequest.url).search, "?mode=test");
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(proxiedRequest.headers.get("x-client-header"), "kept");
	assert.deepEqual(await proxiedRequest.json(), { sql: "SELECT 1" });
});

void test("demo auth only resolves configured lixes", async () => {
	const testEnv = env({
		extra: {
			LIXRAY_DEMO: "1",
			LIXRAY_DEMO_LIX_IDS: DEMO_LIX_ID,
		},
	});
	const accepted = await handleRequest(
		new Request(`https://pr-42-lixray-preview.example/lix/v1/${DEMO_LIX_ID}/`, {
			headers: { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` },
		}),
		testEnv,
		{ lixFetch: async () => new Response("ok") },
	);
	assert.equal(accepted.status, 200);

	const deniedResponse = await handleRequest(
		new Request(`https://pr-42-lixray-preview.example/lix/v1/${LIX_A}/`, {
			headers: { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` },
		}),
		testEnv,
	);
	// Public routes resolve globally. An unconfigured demo lix falls
	// through to the same public resolver and is indistinguishable from missing.
	assert.equal(deniedResponse.status, 404);
});

void test("demo auth rejects an incorrect bearer token without Supabase", async () => {
	const response = await authenticateWithSupabase(
		remoteLixRequest("/", {
			headers: { Authorization: "Bearer incorrect" },
		}),
		env({
			extra: {
				LIXRAY_DEMO: "1",
				LIXRAY_DEMO_LIX_IDS: DEMO_LIX_ID,
			},
		}),
	);
	assert.equal(response.ok, false);
	if (!response.ok) {
		assert.equal(response.response.status, 401);
	}
});

void test("current account RPC maps a login to its canonical actor and profile", async () => {
	let request: Request | undefined;
	const result = await resolveCurrentAccount(
		"login-token",
		{
			SUPABASE_URL: "https://supabase.example",
			SUPABASE_PUBLISHABLE_KEY: "publishable-key",
		},
		async (input, init) => {
			request = new Request(input, init);
			return Response.json([
				{
					account_id: "01920000-0000-7000-8000-000000000601",
					kind: "human",
					name: "Example Account",
					profile_uri:
						"https://lixray.com/profile/11111111-1111-4111-8111-111111111111",
				},
			]);
		},
	);
	assert.deepEqual(result, {
		ok: true,
		account: {
			id: "01920000-0000-7000-8000-000000000601",
			kind: "human",
			name: "Example Account",
			profileUri:
				"https://lixray.com/profile/11111111-1111-4111-8111-111111111111",
		},
	});
	assert.ok(request);
	assert.equal(
		request.url,
		"https://supabase.example/rest/v1/rpc/current_account",
	);
	assert.equal(request.headers.get("authorization"), "Bearer login-token");
});

void test("account resolution accepts accounts before profile bootstrap and rejects missing accounts", async () => {
	for (const row of [
		{ account_id: LIX_A, kind: "human", name: "Account", profile_uri: null },
		null,
	]) {
		const result = await resolveCurrentAccount(
			"login-token",
			{
				SUPABASE_URL: "https://supabase.example",
				SUPABASE_PUBLISHABLE_KEY: "publishable-key",
			},
			async () => Response.json(row ? [row] : []),
		);
		if (row) {
			assert.deepEqual(result, {
				ok: true,
				account: {
					id: LIX_A,
					kind: "human",
					name: "Account",
					profileUri: null,
				},
			});
		} else {
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.response.status, 403);
		}
	}
});

void test("profile refresh checks the namespace access policy for personal owners and organization members", async (t) => {
	for (const member of [true, false]) {
		t.mock.method(
			globalThis,
			"fetch",
			(input: string | URL | Request, init?: RequestInit) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				assert.equal(url.pathname, "/rest/v1/namespaces");
				assert.equal(url.searchParams.get("id"), `eq.${NAMESPACE_ID}`);
				assert.equal(
					request.headers.get("authorization"),
					"Bearer login-token",
				);
				return Promise.resolve(
					Response.json(member ? [{ id: NAMESPACE_ID }] : []),
				);
			},
		);
		assert.deepEqual(
			await resolveNamespaceMembershipWithSupabase(
				NAMESPACE_ID,
				"login-token",
				env({
					extra: {
						SUPABASE_URL: "https://supabase.example",
						SUPABASE_PUBLISHABLE_KEY: "publishable-key",
					},
				}),
			),
			{ ok: true, member },
		);
		t.mock.restoreAll();
	}
});

void test("demo mode keeps OAuth endpoints disabled", async () => {
	const testEnv = env({ extra: { LIXRAY_DEMO: "1" } });
	for (const path of [
		MCP_PROTECTED_RESOURCE_PATH,
		MCP_DOCUMENTATION_PATH,
		SIGNUP_TELEMETRY_PATH,
		"/auth/callback",
		"/oauth/consent",
	]) {
		const response = await handleRequest(
			new Request(`https://preview.example${path}`),
			testEnv,
		);
		assert.equal(response.status, 404);
	}
});

void test("demo mode exposes its namespace through the production profile route", async () => {
	const response = await handleRequest(
		new Request(`http://localhost/profile/${DEMO_PROFILE_NAMESPACE_ID}`),
		env({ extra: { LIXRAY_DEMO: "1" } }),
	);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("content-type"),
		"application/jscontact+json; version=2.0",
	);
	assert.deepEqual(
		await response.json(),
		demoProfileDocument("http://localhost"),
	);
});

void test("Railway PR environments enable the built-in demo lix", async () => {
	// Both naming schemes: configured "lixray-pr-<n>" and Railway's default
	// "pr-<hash>-<n>" used for recreated PR environments.
	for (const name of ["lixray-pr-91", "pr-11b179-85"]) {
		for (const lixId of [DEMO_LIX_ID, DEMO_SECONDARY_LIX_ID]) {
			const testEnv = env({
				extra: { RAILWAY_ENVIRONMENT_NAME: name },
			});
			const response = await handleRequest(
				new Request(`https://preview.example/lix/v1/${lixId}/`, {
					headers: { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` },
				}),
				testEnv,
				{ lixFetch: async () => new Response("ok") },
			);
			assert.equal(response.status, 200, `${name}: ${lixId}`);
		}
	}
});

void test("demo mode exposes authless MCP through the in-memory lix fetcher", async () => {
	let lixFetches = 0;
	const response = await handleRequest(
		new Request("https://preview.example/mcp", { method: "POST" }),
		{
			LIXRAY_DEMO: "1",
			LIXRAY_DEMO_LIX_IDS: `${DEMO_LIX_ID},${LIX_A}`,
		},
		{
			lixFetch: async (lixId, request) => {
				lixFetches += 1;
				assert.equal(lixId, DEMO_LIX_ID);
				assert.equal(request.headers.get("authorization"), null);
				const pathname = new URL(request.url).pathname;
				if (pathname === `/lix/v1/${DEMO_LIX_ID}/`) {
					return Response.json({
						protocolVersion: 9,
						activeBranchId: "main",
						activeAccountId: "00000000-0000-7000-8000-000000000002",
						sessionId: "demo-mcp-session",
					});
				}
				if (
					pathname === `/lix/v1/${DEMO_LIX_ID}/session` &&
					request.method === "DELETE"
				) {
					return new Response(null, { status: 204 });
				}
				assert.equal(pathname, `/lix/v1/${DEMO_LIX_ID}/execute`);
				const body = (await request.json()) as { sql?: string };
				if (typeof body.sql === "string" && body.sql.includes("file_count")) {
					return Response.json({
						columns: [
							{ name: "file_count", type: "integer" },
							{ name: "directory_count", type: "integer" },
						],
						rows: [
							[
								{ kind: "int", value: 0 },
								{ kind: "int", value: 0 },
							],
						],
						rowsAffected: 0,
						notices: [],
					});
				}
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
			},
			mcpTransport: async (_request, service, options) => {
				assert.equal(options.authMode, "none");
				assert.deepEqual(await service.listLixes(), [
					{
						id: DEMO_LIX_ID,
						name: DEMO_LIX_NAME,
						slug: DEMO_LIX_NAME,
						namespace: {
							id: DEMO_ORGANIZATION_ID,
							name: DEMO_ORGANIZATION_NAME,
							handle: DEMO_ORGANIZATION_NAME,
						},
					},
					{
						id: DEMO_SECONDARY_LIX_ID,
						name: DEMO_SECONDARY_LIX_NAME,
						slug: DEMO_SECONDARY_LIX_NAME,
						namespace: {
							id: DEMO_ORGANIZATION_ID,
							name: DEMO_ORGANIZATION_NAME,
							handle: DEMO_ORGANIZATION_NAME,
						},
					},
					{
						id: LIX_A,
						name: "demo-lix-3",
						slug: "demo-lix-3",
						namespace: {
							id: DEMO_ORGANIZATION_ID,
							name: DEMO_ORGANIZATION_NAME,
							handle: DEMO_ORGANIZATION_NAME,
						},
					},
				]);
				const opened = await service.openLix(DEMO_LIX_ID);
				assert.equal(
					(await service.activeBranchId(opened.context)).branchId,
					"main",
				);
				await assert.rejects(
					service.openLix(LIX_B),
					(error: unknown) => isLixError(error) && error.code === "not_found",
				);
				return Response.json({ ok: true });
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(lixFetches, 5);
});

void test("Supabase lix authorization uses the user token and RLS-visible row", async () => {
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
		return Response.json([{ id: LIX_A }]);
	};
	try {
		const failure = await authorizeLixWithSupabase(
			LIX_A,
			{ userId: "user-123", token: "verified-user-token" },
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(failure, null);
		assert.equal(lookupUrl?.pathname, "/rest/v1/lixes");
		assert.equal(lookupUrl?.searchParams.get("id"), `eq.${LIX_A}`);
		assert.equal(lookupHeaders?.get("apikey"), "publishable-key");
		assert.equal(
			lookupHeaders?.get("authorization"),
			"Bearer verified-user-token",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("Supabase lix authorization hides absent or RLS-invisible rows", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json([]);
	try {
		const failure = await authorizeLixWithSupabase(
			LIX_A,
			{ userId: "user-123", token: "verified-user-token" },
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(failure?.status, 403);
		assert.equal(await failure?.text(), "Lix access denied\n");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("Supabase canonical lix resolution joins RLS-visible organization and lix rows", async () => {
	const originalFetch = globalThis.fetch;
	const lookups: URL[] = [];
	globalThis.fetch = async (input, init) => {
		const requestUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(requestUrl);
		lookups.push(url);
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			"Bearer verified-user-token",
		);
		return Response.json([{ lix_id: LIX_A, can_edit: true }]);
	};
	try {
		const resolution = await resolveLixWithSupabase(
			"acme",
			"launch-q3",
			{ userId: "user-123", token: "verified-user-token" },
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.deepEqual(resolution, { ok: true, lixId: LIX_A });
		assert.equal(lookups.length, 1);
		assert.equal(
			lookups[0]?.pathname,
			"/rest/v1/rpc/resolve_public_lix_by_route",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("Supabase namespace profile resolution uses the public namespace ID", async () => {
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
		return Response.json([
			{
				document: PROFILE_DOCUMENT,
				updated_at: "2026-08-21T12:00:00.000Z",
			},
		]);
	};
	try {
		const resolution = await resolveNamespaceProfileWithSupabase(
			NAMESPACE_ID,
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.deepEqual(resolution, {
			ok: true,
			document: PROFILE_DOCUMENT,
			updatedAt: "2026-08-21T12:00:00.000Z",
		});
		assert.equal(lookupUrl?.pathname, "/rest/v1/namespace_profiles");
		assert.equal(lookupUrl?.searchParams.get("select"), "document,updated_at");
		assert.equal(
			lookupUrl?.searchParams.get("namespace_id"),
			`eq.${NAMESPACE_ID}`,
		);
		assert.equal(lookupHeaders?.get("apikey"), "publishable-key");
		assert.equal(lookupHeaders?.get("authorization"), null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test("Supabase namespace profile resolution distinguishes absence from invalid data", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => Response.json([]);
		const missing = await resolveNamespaceProfileWithSupabase(
			NAMESPACE_ID,
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.response.status, 404);

		globalThis.fetch = async () => Response.json([{ document: {} }]);
		const invalid = await resolveNamespaceProfileWithSupabase(
			NAMESPACE_ID,
			env({
				extra: {
					SUPABASE_URL: "https://project.supabase.co",
					SUPABASE_PUBLISHABLE_KEY: "publishable-key",
				},
			}),
		);
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.equal(invalid.response.status, 502);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function remoteLixRequest(endpoint: string, init?: RequestInit) {
	return new Request(`https://example.test/lix/v1/${LIX_A}${endpoint}`, init);
}

function mcpLixFetch(protocolPaths: string[], sessionId: string) {
	return async (lixId: string, request: Request): Promise<Response> => {
		assert.equal(lixId, LIX_A);
		const path = new URL(request.url).pathname;
		protocolPaths.push(path);
		if (path === `/lix/v1/${LIX_A}/`) {
			return Response.json({
				protocolVersion: 9,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId,
			});
		}
		if (path === `/lix/v1/${LIX_A}/session` && request.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		if (path === `/lix/v1/${LIX_A}/execute`) {
			const body = (await request.json()) as { sql?: string };
			if (typeof body.sql === "string" && body.sql.includes("file_count")) {
				return Response.json({
					columns: [
						{ name: "file_count", type: "integer" },
						{ name: "directory_count", type: "integer" },
					],
					rows: [
						[
							{ kind: "int", value: 0 },
							{ kind: "int", value: 0 },
						],
					],
					rowsAffected: 0,
					notices: [],
				});
			}
			return Response.json({
				columns: [{ name: "value", type: "text" }],
				rows: [[{ kind: "text", value: "commit-1" }]],
				rowsAffected: 0,
				notices: [],
			});
		}
		assert.equal(
			path,
			"/lix/v1/11111111-1111-4111-8111-111111111111/execute-batch",
		);
		return Response.json([
			{
				statementIndex: 0,
				columns: [{ name: "value", type: "integer" }],
				rows: [[{ kind: "int", value: 1 }]],
				rowsAffected: 0,
				notices: [],
			},
		]);
	};
}

function mcpLixSummaries() {
	return [
		{
			id: LIX_A,
			name: "Launch Q3",
			slug: "launch-q3",
			namespace: {
				id: "00000000-0000-7000-8000-000000000001",
				name: "Acme",
				handle: "acme",
			},
		},
	];
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

function resolved(lixId: string) {
	return async (requestedLixId: string) =>
		requestedLixId === lixId
			? null
			: new Response("Lix access denied\n", { status: 403 });
}

function unresolved(status: number) {
	return async () => new Response("Lix access denied\n", { status });
}

function env(options: { extra?: Partial<WorkerEnv> }): WorkerEnv {
	return { ...options.extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

void test("MCP boundary failures capture traces only after authentication", async () => {
	for (const scenario of [
		"auth-throw",
		"auth-response",
		"storage",
		"transport-throw",
		"transport-response",
	] as const) {
		const observations: Array<{
			requestId: string;
			stage: string;
			statusCode: number;
			traceId: string;
		}> = [];
		let flushed = 0;
		let initialized = 0;
		const response = await handleRequest(
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: { "x-request-id": "debug-request" },
			}),
			env({}),
			{
				authenticateMcp:
					scenario === "auth-throw"
						? async () => {
								throw new Error("SECRET bearer token");
							}
						: scenario === "auth-response"
							? async () => ({
									ok: false,
									response: new Response("Unauthorized", {
										status: 401,
										headers: { "WWW-Authenticate": "Bearer" },
									}),
								})
							: authenticatedMcp(),
				...(scenario === "storage"
					? {}
					: { lixFetch: async () => new Response("unused") }),
				createMcpTelemetry: () => {
					initialized++;
					return {
						onToolCall: () => undefined,
						onTransport: (observation) => observations.push(observation),
						flush: async () => {
							assert.equal(observations.length, 1);
							flushed++;
						},
					};
				},
				mcpTransport: async () => {
					if (scenario === "transport-throw")
						throw new Error("SECRET transport details");
					return new Response("unavailable", { status: 503 });
				},
			},
		);
		assert.equal(
			response.status,
			scenario === "auth-response"
				? 401
				: scenario === "transport-response"
					? 503
					: 500,
		);
		const authenticated = !scenario.startsWith("auth");
		assert.equal(initialized, authenticated ? 1 : 0);
		assert.equal(observations.length, authenticated ? 1 : 0);
		assert.equal(flushed, authenticated ? 1 : 0);
		if (authenticated) {
			assert.equal(
				observations[0]?.requestId,
				response.headers.get("x-request-id"),
			);
			assert.equal(
				observations[0]?.stage,
				scenario === "storage" ? "setup" : "transport",
			);
			assert.ok(observations[0]?.traceId);
		}
		const body = await response.text();
		assert.ok(!body.includes("SECRET"));
		if (response.status === 500) assert.ok(body.includes("debug-request"));
		if (response.status === 401)
			assert.equal(response.headers.get("www-authenticate"), "Bearer");
	}
});

void test("MCP worker forwards transport observations once and isolates telemetry failures", async () => {
	let captures = 0;
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: () => ({
				onToolCall: () => undefined,
				onTransport: () => {
					captures++;
					throw new Error("capture failed");
				},
				flush: async () => undefined,
			}),
			mcpTransport: async (_request, _service, options) => {
				options.onTransport?.({
					requestId: options.requestId!,
					traceId: options.traceContext!.traceId!,
					stage: "transport",
					statusCode: 500,
					durationMs: 1,
					outcome: "error",
				});
				return new Response("transport failure", { status: 500 });
			},
		},
	);
	assert.equal(response.status, 500);
	assert.equal(await response.text(), "transport failure");
	assert.equal(captures, 1);
});

void test("MCP telemetry initialization failure does not break a successful request", async () => {
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: () => {
				throw new Error("unavailable telemetry");
			},
			mcpTransport: async () => new Response("ok"),
		},
	);
	assert.equal(await response.text(), "ok");
});

void test("MCP cleanup failures preserve successful transport traces and flush telemetry", async (t) => {
	t.mock.method(WorkerLixRuntimeClient.prototype, "close", async () => {
		throw new Error("cleanup failed");
	});
	t.mock.method(console, "warn", () => undefined);
	let flushes = 0;
	const observations: Array<{ outcome: string; statusCode: number }> = [];
	const response = await handleRequest(
		new Request("https://example.test/mcp", { method: "POST" }),
		env({}),
		{
			authenticateMcp: authenticatedMcp(),
			lixFetch: async () => new Response("unused"),
			createMcpTelemetry: () => ({
				onToolCall: () => undefined,
				onTransport: (observation) => observations.push(observation),
				flush: async () => {
					flushes++;
				},
			}),
			mcpTransport: async (_request, _service, options) => {
				options.onTransport?.({
					requestId: options.requestId!,
					traceId: options.traceContext!.traceId!,
					stage: "transport",
					statusCode: 200,
					durationMs: 1,
					outcome: "success",
				});
				return new Response("ok");
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
	assert.equal(flushes, 1);
	assert.equal(observations.length, 1);
	assert.equal(observations[0]?.outcome, "success");
	assert.equal(observations[0]?.statusCode, 200);
});

void test("published entity boot resolves a UUID with a fixed query before authorizing its live path", async () => {
	const entityId = "33333333-3333-4333-8333-333333333333";
	let authorized = false;
	let released = false;
	const response = await handleRequest(
		new Request(
			`https://example.test/api/published/entity?namespace=opral&repository=monorepo&kind=directory&id=${entityId}`,
		),
		env({
			extra: {
				SUPABASE_URL: "https://database.test",
				SUPABASE_SERVICE_ROLE_KEY: "server-key",
			},
		}),
		{
			fetch: async (input) =>
				Response.json(
					new URL(input instanceof Request ? input.url : input).pathname ===
						"/rest/v1/handles"
						? [{ namespace_id: LIX_A }]
						: [{ id: LIX_A }],
				),
			resolvePublicLix: async (lixId, _env, path) => {
				assert.equal(lixId, LIX_A);
				assert.equal(path, "/published/renamed");
				authorized = true;
				return { ok: true, lixId, scope: "path" };
			},
			lixFetch: async (_lixId, request) => {
				const path = new URL(request.url).pathname;
				if (path === `/lix/v1/${LIX_A}/`)
					return Response.json({
						protocolVersion: 9,
						activeBranchId: "main",
						activeAccountId: "00000000-0000-7000-8000-000000000002",
						sessionId: "entity-session",
					});
				if (path.endsWith("/session")) {
					released = true;
					return new Response(null, { status: 204 });
				}
				const query = (await request.json()) as {
					sql: string;
					params: unknown;
				};
				assert.equal(
					query.sql,
					"SELECT id, path FROM lix_directory WHERE id = $1 LIMIT 1",
				);
				assert.deepEqual(query.params, [{ kind: "text", value: entityId }]);
				assert.equal(authorized, false);
				return Response.json({
					columns: [
						{ name: "id", type: "text" },
						{ name: "path", type: "text" },
					],
					rows: [
						[
							{ kind: "text", value: entityId },
							{ kind: "text", value: "/published/renamed" },
						],
					],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		lixId: LIX_A,
		id: entityId,
		kind: "directory",
		path: "/published/renamed",
	});
	assert.equal(authorized, true);
	assert.equal(released, true);
});

for (const [endpoint, method] of [
	["/sync/descriptor", "GET"],
	["/sync/update", "POST"],
	["/sync/native-objects", "POST"],
	["/sync/native-object-range", "POST"],
	["/sync/native-metadata", "POST"],
	["/sync/baseline-lease/renew", "POST"],
] as const) {
	const payload =
		endpoint === "/sync/update"
			? { branchId: LIX_A, after: 0, knownCursor: 0, interests: [] }
			: { bounded: "native request" };
	for (const scope of ["repository", "path"] as const) {
		void test(`partial hydration ${endpoint} requires repository public access (${scope})`, async () => {
			let proxied = false;
			const response = await handleRequest(
				remoteLixRequest(endpoint, {
					method,
					headers: {
						"x-lixray-public-path": "/finance",
						"content-type": "application/json",
					},
					...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
				}),
				env({}),
				{
					resolvePublicLix: async () => ({ ok: true, lixId: LIX_A, scope }),
					lixFetch: async (_id, request) => {
						proxied = true;
						assert.equal(request.method, method);
						assert.equal(request.headers.get("authorization"), null);
						if (method === "POST")
							assert.deepEqual(await request.json(), payload);
						return Response.json({ ok: true });
					},
				},
			);
			assert.equal(response.status, scope === "repository" ? 200 : 404);
			assert.equal(proxied, scope === "repository");
		});
	}
}
