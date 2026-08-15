import {
	createRemoteJWKSet,
	jwtVerify,
	type JWTPayload,
	type JWTVerifyGetKey,
} from "jose";
import {
	DEMO_AUTH_TOKEN,
	DEMO_ORGANIZATION_ID,
	DEMO_ORGANIZATION_NAME,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
} from "../lib/demo-identity.ts";
import {
	isClearlyReadOnlySql,
	type ParseSqlScript,
} from "../lib/lix-sql-access.ts";
import { WorkerLixRuntimeClient } from "../mcp/runtime-client.ts";
import { LixService, type LixSummary } from "../mcp/lix-service.ts";
import {
	handleMcpTransport,
	MCP_DOCUMENTATION_PATH,
	MCP_PATH,
	MCP_PROTECTED_RESOURCE_PATH,
	MCP_PROTECTED_RESOURCE_URL,
	MCP_RESOURCE,
	mcpDocumentationResponse,
	mcpUnauthorizedResponse,
	requestIdForMcpRequest,
	protectedResourceMetadataResponse,
	withMcpRequestId,
	type McpToolCallObservation,
} from "../mcp/server.ts";
import {
	createMcpTelemetrySession,
	type McpTelemetrySession,
} from "./mcp-telemetry.ts";
import { resolveSupabaseLixId } from "./lix-resolver.ts";

export interface WorkerEnv {
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	SUPABASE_JWKS_URL?: string;
	/**
	 * Public Supabase URL used as the JWT issuer. This can differ from
	 * `SUPABASE_URL` when the web service reaches a locally hosted Supabase
	 * instance through Docker's host gateway.
	 */
	SUPABASE_JWT_ISSUER_URL?: string;
	LIXRAY_DEMO?: string;
	LIXRAY_DEMO_LIX_IDS?: string;
	LIXRAY_LIX_SERVICE_URL?: string;
	/** Temporary deployment fallback; remove after production variables migrate. */
	LIXRAY_DEMO_REPOSITORY_IDS?: string;
	/** Temporary deployment fallback; remove after production variables migrate. */
	LIXRAY_REPOSITORY_SERVICE_URL?: string;
	/** Temporary deployment fallback; remove after Railway uses LIXRAY_LIX_SERVICE_URL. */
	LIXRAY_WORKSPACE_SERVICE_URL?: string;
	LIXRAY_INTERNAL_TOKEN?: string;
	GOOGLE_ANALYTICS_ID?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	/** HMAC key used to sign stateless MCP Lix contexts. */
	LIXRAY_CONTEXT_SIGNING_KEY?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	RAILWAY_GIT_COMMIT_SHA?: string;
}

export interface RequestExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
	props: Record<string, unknown>;
}

interface HandleRequestOptions {
	authenticate?: AuthenticateRequest;
	authenticateMcp?: AuthenticateMcpRequest;
	authorizeLix?: AuthorizeLix;
	resolveLix?: ResolveLix;
	resolvePublicLix?: ResolvePublicLix;
	parseSqlScript?: ParseSqlScript;
	mcpTransport?: typeof handleMcpTransport;
	lixFetch?: (lixId: string, request: Request) => Promise<Response>;
	lixSummaries?: ReadonlyArray<LixSummary>;
	fallback?: (request: Request, env: WorkerEnv) => Promise<Response>;
	fetch?: typeof fetch;
	executionContext?: RequestExecutionContext;
	createMcpTelemetry?: typeof createMcpTelemetrySession;
	recordMcpLixConnection?: RecordMcpLixConnection;
}

interface AuthenticatedUser {
	userId: string;
	token: string;
	isDemo?: boolean;
}

interface AuthenticatedMcpUser extends AuthenticatedUser {
	clientId: string;
}

type RecordMcpLixConnection = (
	observation: McpToolCallObservation,
	auth: AuthenticatedMcpUser,
	env: WorkerEnv,
) => Promise<void>;

export type AuthenticateRequest = (
	request: Request,
	env: WorkerEnv,
) => Promise<AuthResult>;

export type AuthenticateMcpRequest = (
	request: Request,
	env: WorkerEnv,
) => Promise<McpAuthResult>;

type AuthorizeLix = (
	lixId: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
) => Promise<Response | null>;

export type ResolveLix = (
	namespace: string,
	lixSlug: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
) => Promise<LixResolution>;

type LixResolution =
	| { ok: true; lixId: string }
	| { ok: false; response: Response };

/**
 * Resolves a live lix for the public read transport. This deliberately
 * does not use the member-scoped lix lookup: a valid browser JWT alone
 * must never turn a public reader into an editor.
 */
type ResolvePublicLix = (
	namespace: string,
	lixSlug: string,
	env: WorkerEnv,
) => Promise<LixResolution>;

/**
 * Lix's SQL script parser, injected by the worker entry so the public read
 * gate classifies statements with the same grammar the engine executes —
 * not a transport-level keyword check.
 */
type AuthResult =
	| { ok: true; auth: AuthenticatedUser }
	| { ok: false; response: Response };

type McpAuthResult =
	| { ok: true; auth: AuthenticatedMcpUser }
	| { ok: false; response: Response };

type McpClaimsValidation =
	| { ok: true; userId: string; clientId: string }
	| {
			ok: false;
			error: "invalid_token" | "insufficient_scope";
			description: string;
	  };

const REMOTE_LIX_API_PATH = /^\/@([^/]+)\/([^/]+)\/lix\/v1(?:\/(.*))?$/;
const PROD_DEV_AUTH_PATH = "/auth/email";
const PROD_DEV_EMAIL = "dev@lixray.com";
const TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";
const ORGANIZATION_HANDLE_PATTERN = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;
const LIX_SLUG_PATTERN = /^[a-z0-9](?:-?[a-z0-9]){0,99}$/;
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

	if (url.pathname === PROD_DEV_AUTH_PATH) {
		return handleProdDevAuth(request, env, options.fetch ?? fetch);
	}

	if (isDemoMode(env) && isProductionOnlyPath(url.pathname)) {
		return new Response("Not found\n", { status: 404 });
	}

	if (url.pathname === MCP_PROTECTED_RESOURCE_PATH) {
		if (request.method === "OPTIONS") return corsPreflight();
		if (request.method !== "GET") {
			return new Response("Method not allowed\n", { status: 405 });
		}
		return protectedResourceMetadataResponse(mcpDiscoveryOptions(url, env));
	}

	if (url.pathname === MCP_DOCUMENTATION_PATH) {
		return request.method === "GET"
			? mcpDocumentationResponse(mcpDiscoveryOptions(url, env))
			: new Response("Method not allowed\n", { status: 405 });
	}

	if (url.pathname === MCP_PATH) {
		const requestId = requestIdForMcpRequest(request);
		if (request.method === "OPTIONS") {
			return withMcpRequestId(corsPreflight(), requestId);
		}
		const executionContext = options.executionContext ?? noopExecutionContext();
		const authenticateMcp =
			options.authenticateMcp ?? authenticateMcpWithSupabase;
		const authResult = await authenticateMcp(request, env);
		if (!authResult.ok) return withMcpRequestId(authResult.response, requestId);
		const authorizeLix = options.authorizeLix ?? authorizeLixWithSupabase;
		// This positive cache is recreated for every MCP HTTP request.
		const authorizedLixIds = new Set<string>();
		if (!options.lixFetch) {
			return withMcpRequestId(
				new Response("Lix storage is not configured\n", { status: 500 }),
				requestId,
			);
		}
		const client = new WorkerLixRuntimeClient(
			env,
			authResult.auth,
			async (lixId, auth) => {
				if (authorizedLixIds.has(lixId)) return null;
				const failure = await authorizeLix(lixId, auth, env);
				if (failure === null) authorizedLixIds.add(lixId);
				return failure;
			},
			{
				signal: request.signal,
				lixFetch: options.lixFetch,
				lixSummaries:
					options.lixSummaries ??
					(isDemoMode(env) ? demoLixSummaries(env) : undefined),
			},
		);
		const telemetry = (options.createMcpTelemetry ?? createMcpTelemetrySession)(
			env,
			{
				userId: authResult.auth.userId,
				clientId: authResult.auth.clientId,
				isDemo: authResult.auth.isDemo,
			},
		);
		const pendingConnectionRecords: Array<Promise<void>> = [];
		const recordMcpLixConnection =
			options.recordMcpLixConnection ?? recordMcpLixConnectionWithSupabase;
		const onToolCall = (observation: McpToolCallObservation): void => {
			telemetry?.onToolCall(observation);
			if (
				authResult.auth.isDemo ||
				observation.outcome !== "success" ||
				!observation.lixId
			) {
				return;
			}
			pendingConnectionRecords.push(
				recordMcpLixConnection(observation, authResult.auth, env).catch(
					(error: unknown) => {
						console.warn("Failed to record MCP Lix connection", {
							lixId: observation.lixId,
							toolName: observation.toolName,
							error: error instanceof Error ? error.message : String(error),
						});
					},
				),
			);
		};
		const posthogToken = telemetry ? env.POSTHOG_PROJECT_TOKEN : undefined;
		const onPosthogFlush = posthogToken
			? (flush: () => Promise<void>): void => {
					const work = flush().catch((caught: unknown) => {
						console.warn("Failed to flush PostHog MCP analytics", caught);
					});
					executionContext.waitUntil(work);
				}
			: undefined;
		let responseCleanupDeferred = false;
		const cleanup = async (): Promise<void> => {
			await Promise.all(pendingConnectionRecords);
			scheduleMcpTelemetryFlush(executionContext, telemetry);
			await client.close();
		};
		try {
			const response = withMcpRequestId(
				await (options.mcpTransport ?? handleMcpTransport)(
					request,
					new LixService(client, {
						contextSigningKey: env.LIXRAY_CONTEXT_SIGNING_KEY,
						principal: {
							userId: authResult.auth.userId,
							clientId: authResult.auth.clientId,
						},
					}),
					{
						authMode: isDemoMode(env) ? "none" : "oauth",
						requestId,
						onToolCall,
						posthogToken,
						posthogHost: env.POSTHOG_HOST,
						posthogDistinctId: authResult.auth.userId,
						posthogClientId: authResult.auth.clientId,
						onPosthogFlush,
						parseSqlScript: options.parseSqlScript,
					},
				),
				requestId,
			);
			if (isStreamingMcpResponse(response)) {
				responseCleanupDeferred = true;
				return deferResponseCleanup(response, cleanup);
			}
			return response;
		} finally {
			if (!responseCleanupDeferred) await cleanup();
		}
	}

	const remoteLixMatch = REMOTE_LIX_API_PATH.exec(url.pathname);
	if (remoteLixMatch) {
		const namespace = normalizedRouteSegment(remoteLixMatch[1]);
		const lixSlug = normalizedRouteSegment(remoteLixMatch[2]);
		if (
			!namespace ||
			!lixSlug ||
			!ORGANIZATION_HANDLE_PATTERN.test(namespace) ||
			!LIX_SLUG_PATTERN.test(lixSlug)
		) {
			return new Response("Invalid lix path\n", { status: 400 });
		}

		const endpoint = remoteLixMatch[3]?.replace(/\/+$/, "") ?? "";
		const protocolPath = `/lix/v1${endpoint ? `/${endpoint}` : "/"}`;
		const publicReadRequest = isPublicReadRemoteLixRequest(request, endpoint);

		const authenticate = options.authenticate ?? authenticateWithSupabase;
		if (bearerToken(request)) {
			const authResult = await authenticate(request, env);
			if (authResult.ok) {
				const resolution = await (options.resolveLix ?? resolveLixWithSupabase)(
					namespace,
					lixSlug,
					authResult.auth,
					env,
				);
				if (resolution.ok) {
					return fetchLixRequest(
						resolution.lixId,
						request,
						protocolPath,
						env,
						options,
						authResult.auth.userId,
					);
				}
				// A signed-in non-member falls through to the public read
				// transport instead of a dead end.
				if (!publicReadRequest) return resolution.response;
			} else {
				// A bearer token was supplied but could not be authenticated. Do not
				// downgrade this request to public transport: an expired token must
				// remain distinguishable from a valid non-member public reader.
				return authResult.response;
			}
		} else if (!publicReadRequest) {
			return unauthorized().response;
		}

		const publicResolution = await (
			options.resolvePublicLix ?? resolvePublicLixWithSupabase
		)(namespace, lixSlug, env);
		if (!publicResolution.ok) return publicResolution.response;
		const mutationRejection = await rejectPublicMutation(
			request,
			endpoint,
			options.parseSqlScript,
		);
		if (mutationRejection) return mutationRejection;
		return fetchLixRequest(
			publicResolution.lixId,
			request,
			protocolPath,
			env,
			options,
		);
	}

	return (
		options.fallback?.(request, env) ??
		new Response("Not found\n", { status: 404 })
	);
}

async function handleProdDevAuth(
	request: Request,
	env: WorkerEnv,
	fetchImpl: typeof fetch,
): Promise<Response> {
	const email = productionDevEmail(env);
	if (request.method === "GET") {
		return json(email ? { enabled: true, email } : { enabled: false }, {
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed\n", { status: 405 });
	}
	if (!email) return new Response("Not found\n", { status: 404 });

	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) {
		return new Response("Forbidden\n", { status: 403 });
	}

	let password: unknown;
	try {
		const body: unknown = await request.json();
		password =
			body && typeof body === "object" && "password" in body
				? body.password
				: undefined;
	} catch {
		return json({ msg: "A password is required" }, { status: 400 });
	}
	if (typeof password !== "string" || password.length === 0) {
		return json({ msg: "A password is required" }, { status: 400 });
	}

	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return new Response("Supabase authentication is not configured\n", {
			status: 500,
		});
	}

	const tokenUrl = new URL("/auth/v1/token", env.SUPABASE_URL);
	tokenUrl.searchParams.set("grant_type", "password");
	let response: Response;
	try {
		response = await fetchImpl(tokenUrl, {
			method: "POST",
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ email, password }),
		});
	} catch {
		return new Response("Supabase authentication is unavailable\n", {
			status: 502,
		});
	}

	return new Response(await response.text(), {
		status: response.status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type":
				response.headers.get("content-type") ?? "application/json",
		},
	});
}

function productionDevEmail(env: WorkerEnv): string | null {
	return env.RAILWAY_ENVIRONMENT_NAME?.trim() === "production"
		? PROD_DEV_EMAIL
		: null;
}

async function fetchLixRequest(
	lixId: string,
	request: Request,
	protocolPath: string,
	env: WorkerEnv,
	options: HandleRequestOptions,
	trustedPrincipal?: string,
): Promise<Response> {
	const rewrittenRequest = rewriteLixRequest(
		request,
		protocolPath,
		trustedPrincipal,
	);
	if (options.lixFetch) {
		return options.lixFetch(lixId, rewrittenRequest);
	}
	return new Response("Lix storage is not configured\n", { status: 500 });
}

export async function authenticateWithSupabase(
	request: Request,
	env: WorkerEnv,
): Promise<AuthResult> {
	const demoAuth = authenticateDemo(request, env);
	if (demoAuth) return demoAuth;

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
		const issuer = supabaseJwtIssuer(env);
		const { payload } = await jwtVerify(
			token,
			remoteJwks(env.SUPABASE_JWKS_URL ?? ""),
			{
				algorithms: ["ES256"],
				issuer,
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

export function supabaseJwtIssuer(
	env: Pick<WorkerEnv, "SUPABASE_URL" | "SUPABASE_JWT_ISSUER_URL">,
): string {
	const baseUrl = (
		env.SUPABASE_JWT_ISSUER_URL?.trim() ||
		env.SUPABASE_URL ||
		""
	).replace(/\/$/, "");
	return `${baseUrl}/auth/v1`;
}

function isStreamingMcpResponse(response: Response): boolean {
	return (
		response.body !== null &&
		(response.headers.get("content-type") ?? "")
			.toLowerCase()
			.includes("text/event-stream")
	);
}

function deferResponseCleanup(
	response: Response,
	cleanup: () => Promise<void>,
): Response {
	if (!response.body) return response;
	const reader = response.body.getReader();
	let cleanedUp = false;
	const finish = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		await cleanup();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await finish();
					controller.close();
					return;
				}
				if (value) controller.enqueue(value);
			} catch (error) {
				await finish();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				await finish();
			}
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
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

async function authenticateMcpWithSupabase(
	request: Request,
	env: WorkerEnv,
): Promise<McpAuthResult> {
	if (isDemoMode(env)) {
		return {
			ok: true,
			auth: {
				userId: "lixray-demo",
				token: DEMO_AUTH_TOKEN,
				clientId: "lixray-demo",
				isDemo: true,
			},
		};
	}
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
		const issuer = supabaseJwtIssuer(env);
		const { payload } = await jwtVerify(
			token,
			remoteJwks(env.SUPABASE_JWKS_URL),
			{
				algorithms: ["ES256"],
				issuer,
				audience: "authenticated",
			},
		);
		const claims = validateMcpJwtClaims(
			payload,
			issuer,
			Math.floor(Date.now() / 1000),
			mcpResourceUrl(new URL(request.url)),
		);
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
	const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
	if (!isLocalDevelopmentUrl(url)) {
		return {
			resource: MCP_RESOURCE,
			authorizationServer: supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined,
		};
	}
	return {
		resource: mcpResourceUrl(url),
		protectedResourceUrl: mcpProtectedResourceUrl(url),
		authorizationServer: supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined,
		resourceDocumentationUrl: `${url.origin}${MCP_DOCUMENTATION_PATH}`,
		endpointUrl: `${url.origin}${MCP_PATH}`,
	};
}

function mcpResourceUrl(url: URL): string {
	return isLocalDevelopmentUrl(url) ? url.origin : MCP_RESOURCE;
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
	expectedResource = MCP_RESOURCE,
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
			description: "The LixRay access token is invalid or expired.",
		};
	}

	const scopes =
		typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
	if (
		typeof payload.client_id !== "string" ||
		!payload.client_id ||
		payload.resource !== expectedResource ||
		payload.lixray_mcp !== true ||
		!scopes.includes("openid")
	) {
		return {
			ok: false,
			error: "insufficient_scope",
			description: "Authorize the LixRay MCP app to continue.",
		};
	}

	return {
		ok: true,
		userId: payload.sub,
		clientId: payload.client_id,
	};
}

export async function authorizeLixWithSupabase(
	lixId: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
): Promise<Response | null> {
	if (auth.isDemo) {
		return demoLixIds(env).has(lixId)
			? null
			: new Response("Lix access denied\n", { status: 403 });
	}

	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return new Response("Supabase Data API is not configured\n", {
			status: 500,
		});
	}

	const lookupUrl = new URL("/rest/v1/lixes", env.SUPABASE_URL);
	lookupUrl.searchParams.set("select", "id");
	lookupUrl.searchParams.set("id", `eq.${lixId}`);
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
		return new Response("Lix authorization is unavailable\n", {
			status: 502,
		});
	}

	if (!response.ok) {
		return new Response("Lix authorization is unavailable\n", {
			status: 502,
		});
	}

	try {
		const rows: unknown = await response.json();
		return Array.isArray(rows) &&
			rows.length === 1 &&
			lixRowId(rows[0]) === lixId
			? null
			: new Response("Lix access denied\n", { status: 403 });
	} catch {
		return new Response("Lix authorization is unavailable\n", {
			status: 502,
		});
	}
}

async function recordMcpLixConnectionWithSupabase(
	observation: McpToolCallObservation,
	auth: AuthenticatedMcpUser,
	env: WorkerEnv,
): Promise<void> {
	if (!observation.lixId) return;
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		throw new Error("Supabase Data API is not configured");
	}

	const recordUrl = new URL(
		"/rest/v1/rpc/record_mcp_lix_connection",
		env.SUPABASE_URL,
	);
	const response = await fetch(recordUrl, {
		method: "POST",
		headers: {
			apikey: env.SUPABASE_PUBLISHABLE_KEY,
			Authorization: `Bearer ${auth.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			p_lix_id: observation.lixId,
			p_tool_name: observation.toolName,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Supabase rejected the MCP Lix connection (${response.status})`,
		);
	}
}

export async function resolveLixWithSupabase(
	namespace: string,
	lixSlug: string,
	auth: AuthenticatedUser,
	env: WorkerEnv,
): Promise<LixResolution> {
	if (auth.isDemo) {
		const lix = demoLixSummaries(env).find(
			(candidate) =>
				candidate.namespace.handle === namespace && candidate.slug === lixSlug,
		);
		return lix ? { ok: true, lixId: lix.id } : lixNotFound();
	}

	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("Supabase Data API is not configured\n", {
				status: 500,
			}),
		};
	}

	const result = await resolveSupabaseLixId({
		supabaseUrl: env.SUPABASE_URL,
		publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
		accessToken: auth.token,
		namespace,
		lixSlug,
	});
	if (!result.ok) {
		return result.reason === "not_found"
			? lixNotFound()
			: lixResolutionUnavailable();
	}
	return { ok: true, lixId: result.lixId };
}

function lixNotFound(): LixResolution {
	return {
		ok: false,
		response: new Response("Lix not found\n", { status: 404 }),
	};
}

function lixResolutionUnavailable(): {
	ok: false;
	response: Response;
} {
	return {
		ok: false,
		response: new Response("Lix resolution is unavailable\n", {
			status: 502,
		}),
	};
}

/**
 * The public route resolver is deliberately separate from member resolution.
 * It exposes only live route metadata through a security-definer RPC that is
 * callable anonymously.
 */
async function resolvePublicLixWithSupabase(
	namespace: string,
	lixSlug: string,
	env: WorkerEnv,
): Promise<LixResolution> {
	if (isDemoMode(env)) {
		const lix = demoLixSummaries(env).find(
			(candidate) =>
				candidate.namespace.handle === namespace && candidate.slug === lixSlug,
		);
		return lix ? { ok: true, lixId: lix.id } : lixNotFound();
	}
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("Supabase Data API is not configured\n", {
				status: 500,
			}),
		};
	}

	const lookupUrl = new URL(
		"/rest/v1/rpc/resolve_public_lix_by_route",
		env.SUPABASE_URL,
	);
	let response: Response;
	try {
		response = await fetch(lookupUrl, {
			method: "POST",
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				p_namespace_handle: namespace,
				p_lix_slug: lixSlug,
			}),
		});
	} catch {
		return lixResolutionUnavailable();
	}
	if (!response.ok) {
		return lixResolutionUnavailable();
	}
	try {
		const rows: unknown = await response.json();
		const lixId =
			Array.isArray(rows) && rows.length === 1 ? lixRowId(rows[0]) : null;
		return typeof lixId === "string" && lixId
			? { ok: true, lixId }
			: lixNotFound();
	} catch {
		return lixResolutionUnavailable();
	}
}

function lixRowId(value: unknown): unknown {
	if (!value || typeof value !== "object") return null;
	if ("id" in value) return value.id;
	return "lix_id" in value ? value.lix_id : null;
}

/**
 * The public transport exposes the protocol handshake, one exact binary file
 * read, the SQL-carrying read endpoints, and session release. Branch mutations
 * (`branch/create`, `branch/switch`) change shared lix state and are never
 * public.
 */
function isPublicReadRemoteLixRequest(
	request: Request,
	endpoint: string,
): boolean {
	if (!endpoint) return request.method === "GET";
	if (endpoint === "session") return request.method === "DELETE";
	if (endpoint === "file") return request.method === "GET";
	return (
		request.method === "POST" &&
		["execute", "execute-batch", "observe", "observe/multiplex"].includes(
			endpoint,
		)
	);
}

/**
 * The canonical Lix protocol has no read-only mode, so the service
 * is the authorization boundary for public readers: every SQL statement in a
 * public request must classify as a read. Statements are split by Lix's own
 * script parser (injected as `options.parseSqlScript`) before the keyword
 * check, so a mutation cannot hide behind a multi-statement script. Without a
 * parser the gate fails closed.
 */
async function rejectPublicMutation(
	request: Request,
	endpoint: string,
	parseSqlScript: ParseSqlScript | undefined,
): Promise<Response | null> {
	if (
		!endpoint ||
		endpoint === "session" ||
		(endpoint === "file" && request.method === "GET")
	) {
		return null;
	}
	let statements: Array<{ sql: string; paramCount: number }>;
	try {
		statements = await publicSqlStatements(request, endpoint);
	} catch {
		return publicReadOnlyResponse();
	}
	if (statements.length === 0 || !parseSqlScript) {
		return publicReadOnlyResponse();
	}
	for (const statement of statements) {
		let plan: ReturnType<ParseSqlScript>;
		try {
			plan = parseSqlScript(statement.sql, statement.paramCount);
		} catch {
			return publicReadOnlyResponse();
		}
		if (plan.statements.length === 0) return publicReadOnlyResponse();
		// Observers represent one live query; requiring exactly one parsed
		// statement prevents a read followed by a mutation from hiding behind
		// the SSE endpoint.
		if (endpoint.startsWith("observe") && plan.statements.length !== 1) {
			return publicReadOnlyResponse();
		}
		if (!plan.statements.every((parsed) => isClearlyReadOnlySql(parsed.sql))) {
			return publicReadOnlyResponse();
		}
	}
	return null;
}

async function publicSqlStatements(
	request: Request,
	endpoint: string,
): Promise<Array<{ sql: string; paramCount: number }>> {
	const body: unknown = await request.clone().json();
	if (!body || typeof body !== "object") return [];
	const record = body as Record<string, unknown>;
	const entries =
		endpoint === "execute-batch"
			? record.statements
			: endpoint === "observe/multiplex"
				? record.subscriptions
				: [record];
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new Error("Malformed public statement");
		}
		const { sql, params } = entry as Record<string, unknown>;
		if (typeof sql !== "string" || sql.length === 0) {
			throw new Error("Malformed public statement");
		}
		return { sql, paramCount: Array.isArray(params) ? params.length : 0 };
	});
}

function publicReadOnlyResponse(): Response {
	return Response.json(
		{ error: { code: "LIX_READ_ONLY", message: "lix is read-only" } },
		{ status: 400 },
	);
}

function authenticateDemo(request: Request, env: WorkerEnv): AuthResult | null {
	if (!isDemoMode(env)) return null;
	if (request.headers.get("Authorization") !== `Bearer ${DEMO_AUTH_TOKEN}`) {
		return unauthorized();
	}
	return {
		ok: true,
		auth: { userId: "lixray-demo", token: DEMO_AUTH_TOKEN, isDemo: true },
	};
}

function demoLixIds(env: WorkerEnv): Set<string> {
	const lixIds = new Set(
		(env.LIXRAY_DEMO_LIX_IDS ?? env.LIXRAY_DEMO_REPOSITORY_IDS ?? "")
			.split(",")
			.map((lixId) => lixId.trim())
			.filter(Boolean),
	);
	if (lixIds.size === 0 && isDemoMode(env)) {
		lixIds.add(DEMO_LIX_ID);
	}
	return lixIds;
}

function demoLixSummaries(env: WorkerEnv): Array<LixSummary> {
	return [...demoLixIds(env)].map((lixId, index) => ({
		id: lixId,
		name: lixId === DEMO_LIX_ID ? DEMO_LIX_NAME : `demo-lix-${index + 1}`,
		slug: lixId === DEMO_LIX_ID ? DEMO_LIX_NAME : `demo-lix-${index + 1}`,
		namespace: {
			id: DEMO_ORGANIZATION_ID,
			name: DEMO_ORGANIZATION_NAME,
			handle: DEMO_ORGANIZATION_NAME,
		},
	}));
}

function isDemoMode(env: WorkerEnv): boolean {
	// Railway names PR environments "lixray-pr-<n>" when configured, but
	// recreated ones get the default "pr-<hash>-<n>" — accept both. Keep in
	// sync with web-app/Dockerfile and scripts/assert-railway-env.mjs.
	return (
		env.LIXRAY_DEMO === "1" ||
		/^(lixray-pr-\d+|pr-[a-z0-9]+-\d+)$/.test(
			env.RAILWAY_ENVIRONMENT_NAME ?? "",
		)
	);
}

function isProductionOnlyPath(pathname: string): boolean {
	return (
		pathname === MCP_PROTECTED_RESOURCE_PATH ||
		pathname === MCP_DOCUMENTATION_PATH ||
		pathname === "/auth/callback" ||
		pathname === "/oauth/consent"
	);
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token || null;
}

function unauthorized(): Extract<AuthResult, { ok: false }> {
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

function rewriteLixRequest(
	request: Request,
	protocolPath: string,
	trustedPrincipal?: string,
) {
	const url = new URL(request.url);
	url.pathname = protocolPath;
	const rewritten = new Request(url, request);
	const headers = new Headers(rewritten.headers);
	headers.delete("Authorization");
	headers.delete(TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER);
	if (trustedPrincipal !== undefined) {
		headers.set(TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER, trustedPrincipal);
	}
	return new Request(rewritten, { headers });
}

function normalizedRouteSegment(value: string | undefined): string | null {
	if (value === undefined) return null;
	return safeDecodeURIComponent(value)?.toLowerCase() ?? null;
}

function safeDecodeURIComponent(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function corsPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
			"access-control-allow-headers":
				"Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-*",
			"access-control-max-age": "86400",
		},
	});
}

function noopExecutionContext(): RequestExecutionContext {
	return {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		props: {},
	};
}

function scheduleMcpTelemetryFlush(
	executionContext: RequestExecutionContext,
	telemetry: McpTelemetrySession | null,
): void {
	if (!telemetry) return;
	try {
		const flush = telemetry.flush().catch((caught: unknown) => {
			console.warn("Failed to flush MCP telemetry", caught);
		});
		executionContext.waitUntil(flush);
	} catch (caught) {
		console.warn("Failed to start MCP telemetry flush", caught);
	}
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
