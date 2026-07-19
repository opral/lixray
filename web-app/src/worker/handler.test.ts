import assert from "node:assert/strict";
import test from "node:test";
import {
	DEMO_AUTH_TOKEN,
	DEMO_ORGANIZATION_ID,
	DEMO_ORGANIZATION_NAME,
	DEMO_WORKSPACE_ID,
	DEMO_WORKSPACE_NAME,
} from "../lib/demo-identity.ts";
import { FileServiceError } from "../mcp/file-service.ts";
import {
	authenticateWithSupabase,
	authorizeWorkspaceWithSupabase,
	handleRequest,
	resolveWorkspaceWithSupabase,
	supabaseJwtIssuer,
	validateBrowserJwtClaims,
	validateMcpJwtClaims,
	type AuthenticateRequest,
	type AuthenticateMcpRequest,
	type ResolveWorkspace,
	type ContainerNamespace,
	type WorkerEnv,
} from "./handler.ts";
import {
	MCP_AUTHORIZATION_SERVER,
	MCP_DOCUMENTATION_PATH,
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

void test("localhost discovery advertises local OAuth without changing the stable resource", async () => {
	const response = await handleRequest(
		new Request(`http://localhost:8787${MCP_PROTECTED_RESOURCE_PATH}`),
		env({
			extra: { SUPABASE_URL: "http://127.0.0.1:54321" },
		}),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		resource: MCP_RESOURCE,
		authorization_servers: ["http://127.0.0.1:54321/auth/v1"],
		scopes_supported: ["openid", "email", "profile"],
		resource_documentation: "http://localhost:8787/docs/mcp",
	});
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
			mcpTransport: async (_request, service) => {
				reachedTransport = true;
				assert.equal(
					(
						service as unknown as {
							agentReview?: { sessionId?: string };
						}
					).agentReview?.sessionId,
					"user-123",
					"review ranges are scoped to the authenticated account, not the OAuth client",
				);
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
	} as unknown as ExecutionContext;
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
			mcpTransport: async (_request, _service, context, options) => {
				assert.equal(context, executionContext);
				options.onToolCall?.({
					toolName: "list_workspaces",
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
			toolName: "list_workspaces",
			outcome: "success",
			durationMs: 2,
		},
	]);
	assert.ok(waitedFor);
	await waitedFor;
	assert.equal(flushes, 1);
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

void test("canonical Lix protocol is authenticated, resolved, and forwarded unchanged", async () => {
	const body = {
		statements: [{ sql: "SELECT $1", params: [{ kind: "int", value: 1 }] }],
	};
	let proxiedRequest: Request | undefined;
	const upstream = Response.json([
		{ columns: ["value"], rows: [], rowsAffected: 0, notices: [] },
	]);
	const response = await handleRequest(
		new Request("https://example.test/@Acme/Launch-Q3/lix/v1/execute-batch", {
			method: "POST",
			headers: {
				Authorization: "Bearer user-token",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		}),
		env({}),
		{
			authenticate: authenticated(),
			resolveWorkspace: async (namespace, workspaceSlug, auth) => {
				assert.equal(namespace, "acme");
				assert.equal(workspaceSlug, "launch-q3");
				assert.equal(auth.userId, "user-123");
				return { ok: true, workspaceId: WORKSPACE_A };
			},
			workspaceFetch: async (workspaceId, request) => {
				assert.equal(workspaceId, WORKSPACE_A);
				proxiedRequest = request;
				return upstream;
			},
		},
	);

	assert.equal(response, upstream);
	assert.ok(proxiedRequest);
	assert.equal(new URL(proxiedRequest.url).pathname, "/lix/v1/execute-batch");
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.deepEqual(await proxiedRequest.json(), body);
});

void test("removed workspace sidecar routes return 404 before auth", async () => {
	const response = await handleRequest(
		new Request(
			"https://example.test/v1/workspaces/not-a-uuid/filesystem/mutate",
		),
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

void test("inaccessible workspaces return 403 from mutation routes without starting a container", async () => {
	let started = false;
	const response = await handleRequest(
		remoteLixRequest("/branch/switch", {
			method: "POST",
			headers: { Authorization: "Bearer user-token" },
		}),
		env({
			fetch: async () => {
				started = true;
				return new Response();
			},
		}),
		{ authenticate: authenticated(), resolveWorkspace: unresolved(403) },
	);
	assert.equal(response.status, 403);
	assert.equal(started, false);
});

void test("anonymous public reads resolve publicly and forward without auth", async () => {
	let proxiedRequest: Request | undefined;
	let publicWorkspaceLookups = 0;
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
			resolvePublicWorkspace: async (namespace, workspaceSlug) => {
				publicWorkspaceLookups += 1;
				assert.equal(namespace, "acme");
				assert.equal(workspaceSlug, "launch-q3");
				return { ok: true, workspaceId: WORKSPACE_A };
			},
			parseSqlScript: (sql) => ({ statements: [{ sql }] }),
			workspaceFetch: async (workspaceId, request) => {
				assert.equal(workspaceId, WORKSPACE_A);
				proxiedRequest = request;
				return new Response("public read");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "public read");
	assert.equal(publicWorkspaceLookups, 1);
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.deepEqual(await proxiedRequest.json(), {
		sql: "SELECT path FROM lix_file",
	});
});

void test("anonymous branch mutations remain unauthorized", async () => {
	let publicWorkspaceLookedUp = false;
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/branch/switch", { method: "POST" }),
		env({}),
		{
			authenticate: async () => {
				throw new Error("anonymous unsafe requests must not authenticate");
			},
			resolvePublicWorkspace: async () => {
				publicWorkspaceLookedUp = true;
				return { ok: true, workspaceId: WORKSPACE_A };
			},
			workspaceFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Unauthorized\n");
	assert.equal(publicWorkspaceLookedUp, false);
	assert.equal(proxied, false);
});

void test("public write SQL is rejected before it reaches the workspace", async () => {
	let proxied = false;
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "DELETE FROM lix_file" }),
		}),
		env({}),
		{
			resolvePublicWorkspace: async () => ({
				ok: true,
				workspaceId: WORKSPACE_A,
			}),
			parseSqlScript: (sql) => ({ statements: [{ sql }] }),
			workspaceFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: { code: "LIX_READ_ONLY", message: "workspace is read-only" },
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
			resolvePublicWorkspace: async () => ({
				ok: true,
				workspaceId: WORKSPACE_A,
			}),
			parseSqlScript: (sql) => ({
				statements: sql
					.split(";")
					.map((statement) => ({ sql: statement.trim() })),
			}),
			workspaceFetch: async () => {
				proxied = true;
				return new Response("unexpected");
			},
		},
	);

	assert.equal(response.status, 400);
	assert.equal(proxied, false);
});

void test("public reads fail closed when no SQL parser is configured", async () => {
	const response = await handleRequest(
		remoteLixRequest("/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sql: "SELECT 1" }),
		}),
		env({}),
		{
			resolvePublicWorkspace: async () => ({
				ok: true,
				workspaceId: WORKSPACE_A,
			}),
			workspaceFetch: async () => new Response("unexpected"),
		},
	);

	assert.equal(response.status, 400);
});

void test("authenticated non-members are downgraded to the public read transport", async () => {
	let proxiedRequest: Request | undefined;
	let publicWorkspaceLookups = 0;
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
			resolveWorkspace: unresolved(403),
			resolvePublicWorkspace: async () => {
				publicWorkspaceLookups += 1;
				return { ok: true, workspaceId: WORKSPACE_A };
			},
			parseSqlScript: (sql) => ({ statements: [{ sql }] }),
			workspaceFetch: async (_workspaceId, request) => {
				proxiedRequest = request;
				return new Response("downgraded");
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "downgraded");
	assert.equal(publicWorkspaceLookups, 1);
	assert.ok(proxiedRequest);
	assert.equal(proxiedRequest.headers.get("authorization"), null);
});

void test("authorized requests route by workspace, rewrite paths, preserve bodies and strip auth", async () => {
	let startOptions: unknown;
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
		{ authenticate: authenticated(), resolveWorkspace: resolved(WORKSPACE_A) },
	);

	assert.equal(response.headers.get("content-type"), "text/event-stream");
	const capturedStartOptions = startOptions as {
		cancellationOptions?: { abort?: AbortSignal };
		ports?: number | number[];
		startOptions: { envVars: Record<string, string> };
	};
	assert.equal(capturedStartOptions.cancellationOptions, undefined);
	assert.deepEqual(
		{
			ports: capturedStartOptions.ports,
			startOptions: capturedStartOptions.startOptions,
		},
		{
			ports: 8080,
			startOptions: {
				envVars: {
					S3_ENDPOINT: "https://r2.example",
					S3_BUCKET: "lixray",
					S3_ACCESS_KEY_ID: "access-key",
					S3_SECRET_ACCESS_KEY: "secret-key",
					S3_REGION: "auto",
					SLATEDB_CACHE_DIR: "/tmp/lixray-slatedb-cache",
					SLATEDB_CACHE_MAX_BYTES: "2147483648",
					SLATEDB_BLOCK_CACHE_BYTES: "134217728",
					SLATEDB_METADATA_CACHE_BYTES: "33554432",
					POSTHOG_PROJECT_TOKEN: "project-token",
					POSTHOG_HOST: "https://posthog.example",
					POSTHOG_ENVIRONMENT: "production",
				},
			},
		},
	);
	assert.ok(proxiedRequest);
	assert.equal(
		new URL(proxiedRequest.url).pathname,
		`/workspaces/${WORKSPACE_A}/lix/v1/observe`,
	);
	assert.equal(new URL(proxiedRequest.url).search, "?mode=test");
	assert.equal(proxiedRequest.headers.get("authorization"), null);
	assert.equal(proxiedRequest.headers.get("x-client-header"), "kept");
	assert.deepEqual(await proxiedRequest.json(), { sql: "SELECT 1" });
});

void test("transient container resets retry with a reacquired stub", async () => {
	let acquisitions = 0;
	let starts = 0;
	let fetches = 0;
	const response = await handleRequest(
		remoteLixRequest("/", {
			headers: { Authorization: "Bearer user-token" },
		}),
		env({
			getByName: () => {
				acquisitions += 1;
				return {
					startAndWaitForPorts: async () => {
						starts += 1;
						if (acquisitions === 1) {
							throw new Error(
								"Internal error in Durable Object storage caused object to be reset; reference = retry-me",
							);
						}
					},
					fetch: async () => {
						fetches += 1;
						return new Response("ok");
					},
				};
			},
		}),
		{
			authenticate: authenticated(),
			resolveWorkspace: resolved(WORKSPACE_A),
			containerRetryDelay: async () => undefined,
			containerRetryRandom: () => 1,
		},
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
	assert.equal(acquisitions, 2);
	assert.equal(starts, 2);
	assert.equal(fetches, 1);
});

void test("canonical mutation bodies are not replayed after ambiguous proxy failures", async () => {
	let acquisitions = 0;
	const bodies: Array<unknown> = [];
	const terminalLogs: Array<Array<unknown>> = [];
	const originalConsoleError = console.error;
	console.error = (...arguments_: Array<unknown>) =>
		terminalLogs.push(arguments_);
	const request = remoteLixRequest("/execute", {
		method: "POST",
		headers: {
			Authorization: "Bearer user-token",
			"content-type": "application/json",
		},
		body: JSON.stringify({ sql: "SELECT 1" }),
	});
	let response: Response;
	try {
		response = await handleRequest(
			request,
			env({
				getByName: () => {
					acquisitions += 1;
					return {
						fetch: async (incoming) => {
							assert.equal(incoming.headers.get("authorization"), null);
							bodies.push(await incoming.json());
							throw new Error("Error proxying request to container");
						},
					};
				},
			}),
			{
				authenticate: authenticated(),
				resolveWorkspace: resolved(WORKSPACE_A),
				containerRetryDelay: async () => undefined,
			},
		);
	} finally {
		console.error = originalConsoleError;
	}

	assert.equal(response.status, 503);
	assert.equal(acquisitions, 1);
	assert.deepEqual(bodies, [{ sql: "SELECT 1" }]);
	assert.equal(terminalLogs.length, 1);
	assert.equal(terminalLogs[0]?.[0], "LixRay container request failed");
	assert.deepEqual(
		(terminalLogs[0]?.[1] as { error?: { message?: string } }).error?.message,
		"Error proxying request to container",
	);
});

void test("permanent container startup failures return a controlled 503 response", async () => {
	let fetched = false;
	const response = await handleRequest(
		remoteLixRequest("/", {
			headers: { Authorization: "Bearer user-token" },
		}),
		env({
			getByName: () => ({
				startAndWaitForPorts: async () => {
					throw new Error("S3_ACCESS_KEY_ID is required");
				},
				fetch: async () => {
					fetched = true;
					return new Response("unexpected");
				},
			}),
		}),
		{ authenticate: authenticated(), resolveWorkspace: resolved(WORKSPACE_A) },
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
			remoteLixRequest("/", {
				headers: { Authorization: "Bearer user-token" },
			}),
			testEnv,
			{
				authenticate: authenticated(),
				resolveWorkspace: resolved(workspaceId),
			},
		);
		assert.equal(response.status, 200);
	}
	assert.deepEqual(names, [WORKSPACE_A, WORKSPACE_B]);
});

void test("demo auth on workers.dev only resolves configured workspaces", async () => {
	const testEnv = env({
		extra: {
			LIXRAY_DEMO: "1",
			LIXRAY_DEMO_WORKSPACE_IDS: DEMO_WORKSPACE_ID,
		},
	});
	const accepted = await handleRequest(
		new Request(
			"https://pr-42-lixray-preview.example.workers.dev/@acme/launch-q3/lix/v1/",
			{
				headers: { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` },
			},
		),
		testEnv,
	);
	assert.equal(accepted.status, 200);

	const deniedResponse = await handleRequest(
		new Request(
			"https://pr-42-lixray-preview.example.workers.dev/@acme/missing/lix/v1/",
			{
				headers: { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` },
			},
		),
		testEnv,
	);
	// Public routes resolve globally. An unconfigured demo workspace falls
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
				LIXRAY_DEMO_WORKSPACE_IDS: DEMO_WORKSPACE_ID,
			},
		}),
	);
	assert.equal(response.ok, false);
	if (!response.ok) {
		assert.equal(response.response.status, 401);
	}
});

void test("demo mode keeps OAuth endpoints disabled", async () => {
	const testEnv = env({ extra: { LIXRAY_DEMO: "1" } });
	for (const path of [
		MCP_PROTECTED_RESOURCE_PATH,
		MCP_DOCUMENTATION_PATH,
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

void test("demo mode exposes authless MCP through the in-memory workspace fetcher", async () => {
	let workspaceFetches = 0;
	const response = await handleRequest(
		new Request("https://preview.example/mcp", { method: "POST" }),
		{
			LIXRAY_DEMO: "1",
			LIXRAY_DEMO_WORKSPACE_IDS: `${DEMO_WORKSPACE_ID},${WORKSPACE_A}`,
		},
		{
			workspaceFetch: async (workspaceId, request) => {
				workspaceFetches += 1;
				assert.equal(workspaceId, DEMO_WORKSPACE_ID);
				assert.equal(request.headers.get("authorization"), null);
				const pathname = new URL(request.url).pathname;
				if (pathname === "/lix/v1/") {
					return Response.json({
						protocolVersion: 1,
						activeBranchId: "main",
					});
				}
				assert.equal(pathname, "/lix/v1/execute");
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
			},
			mcpTransport: async (_request, service, _context, options) => {
				assert.equal(options.authMode, "none");
				assert.deepEqual(await service.listWorkspaces(), [
					{
						id: DEMO_WORKSPACE_ID,
						name: DEMO_WORKSPACE_NAME,
						slug: DEMO_WORKSPACE_NAME,
						organization: {
							id: DEMO_ORGANIZATION_ID,
							name: DEMO_ORGANIZATION_NAME,
							handle: DEMO_ORGANIZATION_NAME,
						},
					},
					{
						id: WORKSPACE_A,
						name: "demo-workspace-2",
						slug: "demo-workspace-2",
						organization: {
							id: DEMO_ORGANIZATION_ID,
							name: DEMO_ORGANIZATION_NAME,
							handle: DEMO_ORGANIZATION_NAME,
						},
					},
				]);
				assert.deepEqual(await service.listBranches(DEMO_WORKSPACE_ID), {
					branches: [
						{
							id: "main",
							name: "main",
							hidden: false,
							commitId: "commit-1",
						},
					],
					currentBranchId: "main",
				});
				await assert.rejects(
					service.listBranches(WORKSPACE_B),
					(error: unknown) =>
						error instanceof FileServiceError && error.code === "not_found",
				);
				return Response.json({ ok: true });
			},
		},
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(workspaceFetches, 3);
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

void test("Supabase canonical workspace resolution joins RLS-visible organization and workspace rows", async () => {
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
		return Response.json([
			{ id: WORKSPACE_A, organizations: { id: DEMO_ORGANIZATION_ID } },
		]);
	};
	try {
		const resolution = await resolveWorkspaceWithSupabase(
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
		assert.deepEqual(resolution, { ok: true, workspaceId: WORKSPACE_A });
		assert.equal(lookups.length, 1);
		assert.equal(lookups[0]?.pathname, "/rest/v1/workspaces");
		assert.equal(
			lookups[0]?.searchParams.get("select"),
			"id,organizations!inner(id)",
		);
		assert.equal(
			lookups[0]?.searchParams.get("organizations.handle"),
			"eq.acme",
		);
		assert.equal(lookups[0]?.searchParams.get("slug"), "eq.launch-q3");
		assert.equal(lookups[0]?.searchParams.get("deleted_at"), "is.null");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function remoteLixRequest(endpoint: string, init?: RequestInit) {
	return new Request(
		`https://example.test/@acme/launch-q3/lix/v1${endpoint}`,
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

function resolved(workspaceId: string): ResolveWorkspace {
	return async () => ({ ok: true, workspaceId });
}

function unresolved(status: number): ResolveWorkspace {
	return async () => ({
		ok: false,
		response: new Response("Workspace access denied\n", { status }),
	});
}

function env(options: {
	fetch?: (request: Request) => Promise<Response>;
	getByName?: ContainerNamespace["getByName"];
	extra?: Partial<WorkerEnv>;
}): WorkerEnv {
	return {
		R2_ENDPOINT: "https://r2.example",
		R2_BUCKET: "lixray",
		R2_ACCESS_KEY_ID: "access-key",
		R2_SECRET_ACCESS_KEY: "secret-key",
		R2_REGION: "auto",
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
