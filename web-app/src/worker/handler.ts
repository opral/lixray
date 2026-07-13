import {
	createRemoteJWKSet,
	jwtVerify,
	type JWTPayload,
	type JWTVerifyGetKey,
} from "jose";
import { E2E_AUTH_TOKEN } from "../lib/e2e-auth.ts";
import { WorkerFileServiceBackend } from "../mcp/backend.ts";
import { LixFileService } from "../mcp/file-service.ts";
import {
	handleMcpTransport,
	MCP_DOCUMENTATION_PATH,
	MCP_AUTHORIZATION_SERVER,
	MCP_PATH,
	MCP_PROTECTED_RESOURCE_PATH,
	MCP_PROTECTED_RESOURCE_URL,
	MCP_RESOURCE,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	protectedResourceMetadataResponse,
} from "../mcp/server.ts";

export interface WorkerEnv {
	SLATEDB_CONTAINER: ContainerNamespace;
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	SUPABASE_JWKS_URL?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_STORAGE?: string;
	SLATEDB_CACHE_DIR?: string;
	SLATEDB_CACHE_MAX_BYTES?: string;
	SLATEDB_BLOCK_CACHE_BYTES?: string;
	SLATEDB_METADATA_CACHE_BYTES?: string;
	LIXRAY_E2E_WORKSPACE_ID?: string;
	LIXRAY_E2E_WORKSPACE_IDS?: string;
}

export interface ContainerNamespace {
	getByName(name: string): ContainerStub;
}

export interface ContainerStub {
	startAndWaitForPorts?(options: {
		ports?: number | number[];
		cancellationOptions?: {
			instanceGetTimeoutMS?: number;
			portReadyTimeoutMS?: number;
			waitInterval?: number;
		};
		startOptions: { envVars: Record<string, string> };
	}): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
}

export interface HandleRequestOptions {
	authenticate?: AuthenticateRequest;
	authenticateMcp?: AuthenticateMcpRequest;
	authorizeWorkspace?: AuthorizeWorkspace;
	mcpTransport?: typeof handleMcpTransport;
	fallback?: (request: Request, env: WorkerEnv) => Promise<Response>;
	executionContext?: ExecutionContext;
}

export interface AuthenticatedUser {
	userId: string;
	token: string;
	isE2e?: boolean;
}

export interface AuthenticatedMcpUser extends AuthenticatedUser {
	clientId: string;
}

export type AuthenticateRequest = (
	request: Request,
	env: WorkerEnv,
) => Promise<AuthResult>;

export type AuthenticateMcpRequest = (
	request: Request,
	env: WorkerEnv,
) => Promise<McpAuthResult>;

export type AuthorizeWorkspace = (
	workspaceId: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
) => Promise<Response | null>;

export type AuthResult =
	{ ok: true; auth: AuthenticatedUser } | { ok: false; response: Response };

export type McpAuthResult =
	{ ok: true; auth: AuthenticatedMcpUser } | { ok: false; response: Response };

export type McpClaimsValidation =
	| { ok: true; userId: string; clientId: string }
	| {
			ok: false;
			error: "invalid_token" | "insufficient_scope";
			description: string;
	  };

const WORKSPACE_API_PATH = /^\/v1\/workspaces\/([^/]+)(\/.*)$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jwksByUrl = new Map<string, JWTVerifyGetKey>();

export async function handleRequest(
	request: Request,
	env: WorkerEnv,
	options: HandleRequestOptions = {},
): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/healthz") {
		return json({ ok: true, service: "lixray" });
	}

	if (url.pathname === MCP_PROTECTED_RESOURCE_PATH) {
		if (request.method === "OPTIONS") return corsPreflight();
		return request.method === "GET"
			? protectedResourceMetadataResponse(mcpDiscoveryOptions(url, env))
			: new Response("Method not allowed\n", { status: 405 });
	}

	if (url.pathname === MCP_DOCUMENTATION_PATH) {
		return request.method === "GET"
			? mcpDocumentationResponse(mcpDiscoveryOptions(url, env))
			: new Response("Method not allowed\n", { status: 405 });
	}

	if (url.pathname === MCP_PATH) {
		if (request.method === "OPTIONS") return corsPreflight();
		const authenticateMcp =
			options.authenticateMcp ?? authenticateMcpWithSupabase;
		const authResult = await authenticateMcp(request, env);
		if (!authResult.ok) return authResult.response;
		const authorizeWorkspace =
			options.authorizeWorkspace ?? authorizeWorkspaceWithSupabase;
		const backend = new WorkerFileServiceBackend(
			env,
			authResult.auth,
			async (workspaceId, auth) => authorizeWorkspace(workspaceId, auth, env),
		);
		return (options.mcpTransport ?? handleMcpTransport)(
			request,
			new LixFileService(backend, {
				agentReview: {
					agent: "codex",
					sessionId: authResult.auth.clientId,
				},
			}),
			options.executionContext ?? noopExecutionContext(),
		);
	}

	if (!url.pathname.startsWith("/v1/")) {
		return (
			options.fallback?.(request, env) ??
			new Response("Not found\n", { status: 404 })
		);
	}

	const match = WORKSPACE_API_PATH.exec(url.pathname);
	if (!match) {
		return new Response("Not found\n", { status: 404 });
	}

	const workspaceId = safeDecodeURIComponent(match[1]);
	if (!workspaceId || !UUID_PATTERN.test(workspaceId)) {
		return new Response("Invalid workspace id\n", { status: 400 });
	}

	const authenticate = options.authenticate ?? authenticateWithSupabase;
	const authResult = await authenticate(request, env);
	if (!authResult.ok) return authResult.response;

	const authorizeWorkspace =
		options.authorizeWorkspace ?? authorizeWorkspaceWithSupabase;
	const authorizationFailure = await authorizeWorkspace(
		workspaceId,
		authResult.auth,
		env,
	);
	if (authorizationFailure) return authorizationFailure;

	const container = env.SLATEDB_CONTAINER.getByName(workspaceId);
	try {
		await container.startAndWaitForPorts?.({
			ports: 8080,
			startOptions: {
				envVars: containerEnv(env, workspaceId),
			},
		});
	} catch {
		return Response.json(
			{
				error: {
					code: "CONTAINER_UNAVAILABLE",
					message: "Workspace storage is temporarily unavailable.",
				},
			},
			{ status: 503, headers: { "Retry-After": "1" } },
		);
	}
	return container.fetch(rewriteWorkspaceRequest(request, match[2]));
}

export async function authenticateWithSupabase(
	request: Request,
	env: WorkerEnv,
): Promise<AuthResult> {
	const e2eAuth = authenticateE2e(request, env);
	if (e2eAuth) return e2eAuth;

	const missingVariable = ["SUPABASE_URL", "SUPABASE_JWKS_URL"].find(
		(name) => !env[name as keyof WorkerEnv],
	);
	if (missingVariable) {
		return {
			ok: false,
			response: new Response(`${missingVariable} is not configured\n`, {
				status: 500,
			}),
		};
	}

	const token = bearerToken(request);
	if (!token) return unauthorized();

	try {
		const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "") ?? "";
		const { payload } = await jwtVerify(
			token,
			remoteJwks(env.SUPABASE_JWKS_URL ?? ""),
			{
				algorithms: ["ES256"],
				issuer: `${supabaseUrl}/auth/v1`,
				audience: "authenticated",
			},
		);
		if (!validateBrowserJwtClaims(payload)) return unauthorized();
		return {
			ok: true,
			auth: { userId: payload.sub as string, token },
		};
	} catch {
		return unauthorized();
	}
}

export function validateBrowserJwtClaims(payload: JWTPayload): boolean {
	return (
		typeof payload.sub === "string" &&
		payload.sub.length > 0 &&
		payload.role === "authenticated" &&
		typeof payload.client_id !== "string" &&
		payload.lixray_mcp !== true
	);
}

export async function authenticateMcpWithSupabase(
	request: Request,
	env: WorkerEnv,
): Promise<McpAuthResult> {
	const protectedResourceUrl = mcpProtectedResourceUrl(new URL(request.url));
	if (!env.SUPABASE_URL || !env.SUPABASE_JWKS_URL) {
		return {
			ok: false,
			response: new Response("MCP authentication is not configured\n", {
				status: 500,
			}),
		};
	}
	const token = bearerToken(request);
	if (!token) {
		return {
			ok: false,
			response: mcpUnauthorizedResponse(
				"invalid_token",
				"Sign in to LixRay to continue.",
				protectedResourceUrl,
			),
		};
	}

	try {
		const supabaseUrl = env.SUPABASE_URL.replace(/\/$/, "");
		const { payload } = await jwtVerify(
			token,
			remoteJwks(env.SUPABASE_JWKS_URL),
			{
				algorithms: ["ES256"],
				issuer: `${supabaseUrl}/auth/v1`,
				audience: "authenticated",
			},
		);
		const claims = validateMcpJwtClaims(payload, `${supabaseUrl}/auth/v1`);
		if (!claims.ok) {
			return {
				ok: false,
				response: mcpUnauthorizedResponse(
					claims.error,
					claims.description,
					protectedResourceUrl,
				),
			};
		}
		return {
			ok: true,
			auth: {
				userId: claims.userId,
				token,
				clientId: claims.clientId,
			},
		};
	} catch {
		return {
			ok: false,
			response: mcpUnauthorizedResponse(
				"invalid_token",
				"Sign in to LixRay to continue.",
				protectedResourceUrl,
			),
		};
	}
}

function mcpDiscoveryOptions(url: URL, env: WorkerEnv) {
	if (!isLocalDevelopmentUrl(url)) return {};
	const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
	return {
		protectedResourceUrl: mcpProtectedResourceUrl(url),
		authorizationServer: supabaseUrl
			? `${supabaseUrl}/auth/v1`
			: MCP_AUTHORIZATION_SERVER,
		resourceDocumentationUrl: `${url.origin}${MCP_DOCUMENTATION_PATH}`,
		endpointUrl: `${url.origin}${MCP_PATH}`,
	};
}

function mcpProtectedResourceUrl(url: URL): string {
	return isLocalDevelopmentUrl(url)
		? `${url.origin}${MCP_PROTECTED_RESOURCE_PATH}`
		: MCP_PROTECTED_RESOURCE_URL;
}

function isLocalDevelopmentUrl(url: URL): boolean {
	return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

export function validateMcpJwtClaims(
	payload: JWTPayload,
	expectedIssuer: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): McpClaimsValidation {
	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: typeof payload.aud === "string"
			? [payload.aud]
			: [];
	if (
		payload.iss !== expectedIssuer ||
		!audiences.includes("authenticated") ||
		typeof payload.exp !== "number" ||
		payload.exp <= nowSeconds ||
		!payload.sub ||
		payload.role !== "authenticated"
	) {
		return {
			ok: false,
			error: "invalid_token",
			description: "The Lixray access token is invalid or expired.",
		};
	}

	const scopes =
		typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
	if (
		typeof payload.client_id !== "string" ||
		!payload.client_id ||
		payload.resource !== MCP_RESOURCE ||
		payload.lixray_mcp !== true ||
		!scopes.includes("openid")
	) {
		return {
			ok: false,
			error: "insufficient_scope",
			description: "Authorize the Lixray MCP app to continue.",
		};
	}

	return {
		ok: true,
		userId: payload.sub,
		clientId: payload.client_id,
	};
}

export async function authorizeWorkspaceWithSupabase(
	workspaceId: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
): Promise<Response | null> {
	if (auth.isE2e) {
		return e2eWorkspaceIds(env).has(workspaceId)
			? null
			: new Response("Workspace access denied\n", { status: 403 });
	}

	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return new Response("Supabase Data API is not configured\n", {
			status: 500,
		});
	}

	const lookupUrl = new URL("/rest/v1/workspaces", env.SUPABASE_URL);
	lookupUrl.searchParams.set("select", "id");
	lookupUrl.searchParams.set("id", `eq.${workspaceId}`);
	lookupUrl.searchParams.set("limit", "1");

	let response: Response;
	try {
		response = await fetch(lookupUrl, {
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Authorization: `Bearer ${auth.token}`,
				Accept: "application/json",
			},
		});
	} catch {
		return new Response("Workspace authorization is unavailable\n", {
			status: 502,
		});
	}

	if (!response.ok) {
		return new Response("Workspace authorization is unavailable\n", {
			status: 502,
		});
	}

	try {
		const rows: unknown = await response.json();
		return Array.isArray(rows) &&
			rows.length === 1 &&
			workspaceRowId(rows[0]) === workspaceId
			? null
			: new Response("Workspace access denied\n", { status: 403 });
	} catch {
		return new Response("Workspace authorization is unavailable\n", {
			status: 502,
		});
	}
}

function workspaceRowId(value: unknown): unknown {
	return value && typeof value === "object" && "id" in value ? value.id : null;
}

function authenticateE2e(request: Request, env: WorkerEnv): AuthResult | null {
	if (e2eWorkspaceIds(env).size === 0) return null;
	if (!isLocalhost(new URL(request.url).hostname)) return null;
	if (request.headers.get("Authorization") !== `Bearer ${E2E_AUTH_TOKEN}`) {
		return null;
	}
	return {
		ok: true,
		auth: { userId: "lixray-e2e", token: E2E_AUTH_TOKEN, isE2e: true },
	};
}

function e2eWorkspaceIds(env: WorkerEnv): Set<string> {
	return new Set(
		(env.LIXRAY_E2E_WORKSPACE_IDS ?? env.LIXRAY_E2E_WORKSPACE_ID ?? "")
			.split(",")
			.map((workspaceId) => workspaceId.trim())
			.filter(Boolean),
	);
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token || null;
}

function unauthorized(): AuthResult {
	return {
		ok: false,
		response: new Response("Unauthorized\n", {
			status: 401,
			headers: { "WWW-Authenticate": "Bearer" },
		}),
	};
}

function remoteJwks(url: string): JWTVerifyGetKey {
	let jwks = jwksByUrl.get(url);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(url));
		jwksByUrl.set(url, jwks);
	}
	return jwks;
}

function rewriteWorkspaceRequest(request: Request, containerPath: string) {
	const url = new URL(request.url);
	url.pathname = `/v1${containerPath}`;
	const rewritten = new Request(url, request);
	const headers = new Headers(rewritten.headers);
	headers.delete("Authorization");
	return new Request(rewritten, { headers });
}

function safeDecodeURIComponent(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function isLocalhost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

function corsPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
			"access-control-allow-headers":
				"Authorization, Content-Type, MCP-Protocol-Version",
			"access-control-max-age": "86400",
		},
	});
}

function noopExecutionContext(): ExecutionContext {
	return {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		props: {},
	} as unknown as ExecutionContext;
}

export function containerEnv(
	env: WorkerEnv,
	workspaceId: string,
): Record<string, string> {
	const vars = { SLATEDB_PATH: workspaceId };
	addOptionalEnv(vars, "R2_ENDPOINT", env.R2_ENDPOINT);
	addOptionalEnv(vars, "R2_BUCKET", env.R2_BUCKET);
	addOptionalEnv(vars, "R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
	addOptionalEnv(vars, "R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
	addOptionalEnv(vars, "R2_REGION", env.R2_REGION);
	addOptionalEnv(vars, "SLATEDB_STORAGE", env.SLATEDB_STORAGE);
	addOptionalEnv(vars, "SLATEDB_CACHE_DIR", env.SLATEDB_CACHE_DIR);
	addOptionalEnv(vars, "SLATEDB_CACHE_MAX_BYTES", env.SLATEDB_CACHE_MAX_BYTES);
	addOptionalEnv(
		vars,
		"SLATEDB_BLOCK_CACHE_BYTES",
		env.SLATEDB_BLOCK_CACHE_BYTES,
	);
	addOptionalEnv(
		vars,
		"SLATEDB_METADATA_CACHE_BYTES",
		env.SLATEDB_METADATA_CACHE_BYTES,
	);
	return vars;
}

function json(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
}

function addOptionalEnv(
	vars: Record<string, string>,
	name: string,
	value: string | undefined,
) {
	if (value !== undefined) vars[name] = value;
}
