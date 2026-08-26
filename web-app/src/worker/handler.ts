import { jwtVerify, type JWTPayload } from "jose";
import {
	classifyJwtVerifyError,
	getRemoteJwks,
	persistRemoteJwksIfPresent,
	warmRemoteJwks,
} from "./jwt-verifier.ts";
import {
	DEMO_AUTH_TOKEN,
	DEMO_ORGANIZATION_ID,
	DEMO_ORGANIZATION_NAME,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
} from "../lib/demo-identity.ts";
import { isClearlyReadOnlySql } from "../lib/lix-sql-access.ts";
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
import {
	createLixrMcpTelemetrySession,
	analyzeSqlOperation,
	detectFileWrites,
	computeContentHash,
	getFileExtension,
} from "./lixr-mcp-telemetry.ts";
import { resolveSupabaseLixId } from "./lix-resolver.ts";
import {
	isDemoEnvironment,
	resolveOfficialMcpPosthogToken,
} from "./mcp-posthog-env.ts";

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
	/** Personal API key (`phx_`). Never used as a capture token. */
	POSTHOG_API_KEY?: string;
	VITE_PUBLIC_POSTHOG_TOKEN?: string;
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
	/** HMAC key used to sign stateless MCP Lix contexts. */
	LIXRAY_CONTEXT_SIGNING_KEY?: string;
	/**
	 * JSON file used to persist the Supabase JWKS across process restarts.
	 * Railway recycle must not drop a previously-valid MCP bearer.
	 */
	LIXRAY_JWKS_CACHE_PATH?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	RAILWAY_DEPLOYMENT_ID?: string;
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
	publicPath?: string,
) => Promise<PublicLixResolution>;

type PublicLixResolution =
	| { ok: true; lixId: string; scope?: "repository" | "path" }
	| { ok: false; response: Response };

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
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const OPENAI_APPS_CHALLENGE_TOKEN =
	"RBTbX7uPYZwmyPGnWXM2eMruvkdC6MlM3Xsh95AqROU";
const PROD_DEV_EMAIL = "dev@lixray.com";
const PUBLIC_PRODUCTION_ORIGIN = "https://lixray.com";
const TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";
// Keep server-owned public reads attributed to Lix's built-in anonymous
// account. Protocol principals are persisted as lix_account IDs, so an
// arbitrary service label is not valid here.
const LIX_ANONYMOUS_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";
const ORGANIZATION_HANDLE_PATTERN = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;
const LIX_SLUG_PATTERN = /^[a-z0-9](?:-?[a-z0-9]){0,99}$/;

type ServerTimingMetric = {
	readonly name:
		| "lixray-web-auth"
		| "lixray-web-resolve"
		| "lixray-server-roundtrip";
	readonly durationMs: number;
};

export async function handleRequest(
	request: Request,
	env: WorkerEnv,
	options: HandleRequestOptions = {},
): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/healthz") {
		const deploymentId = env.RAILWAY_DEPLOYMENT_ID?.trim() || null;
		return json(
			{ ok: true, service: "lixray", deploymentId },
			{
				headers: {
					"cache-control": "no-store",
					...(deploymentId ? { "x-railway-deployment-id": deploymentId } : {}),
				},
			},
		);
	}

	if (url.pathname === OPENAI_APPS_CHALLENGE_PATH) {
		if (request.method !== "GET") {
			return new Response("Method not allowed\n", { status: 405 });
		}
		return new Response(OPENAI_APPS_CHALLENGE_TOKEN, {
			headers: {
				"cache-control": "no-store",
				"content-type": "text/plain; charset=utf-8",
			},
		});
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
		const lixrTelemetry = createLixrMcpTelemetrySession(env, {
			userId: authResult.auth.userId,
			clientId: authResult.auth.clientId,
			isDemo: authResult.auth.isDemo,
		});
		const pendingConnectionRecords: Array<Promise<void>> = [];
		const recordMcpLixConnection =
			options.recordMcpLixConnection ?? recordMcpLixConnectionWithSupabase;

		const importSession = {
			fileWrites: new Set<string>(),
			firstFileAdded: false,
			totalChars: 0,
			totalBytes: 0,
			toolCallCount: 0,
			startTime: Date.now(),
			lixId: undefined as string | undefined,
		};

		const onToolCall = (observation: McpToolCallObservation): void => {
			if (lixrTelemetry && observation.outcome === "success") {
				const sqlAnalysis = observation.executeInput
					? analyzeSqlOperation(observation.executeInput)
					: undefined;
				const fileWrites = observation.rawStatements
					? detectFileWrites(observation.rawStatements)
					: observation.executeInput
						? detectFileWrites(
								observation.executeInput.statements.map((s) => ({
									sql: s.sanitizedSql,
								})),
							)
						: [];

				importSession.toolCallCount++;
				if (observation.lixId) importSession.lixId = observation.lixId;

				// Enrich observation with file content size for $mcp_tool_call eventProperties
				let totalContentChars = 0;
				let totalContentBytes = 0;

				for (const write of fileWrites) {
					if (write.content) {
						const contentBytes = Buffer.byteLength(write.content, "utf8");
						const contentChars = write.content.length;
						const contentHash = computeContentHash(write.content);
						const fileExtension = getFileExtension(write.path);

						totalContentChars += contentChars;
						totalContentBytes += contentBytes;
						importSession.totalChars += contentChars;
						importSession.totalBytes += contentBytes;
						importSession.fileWrites.add(write.path);

						const writeProps = {
							file_path: write.path,
							file_extension: fileExtension,
							char_count: contentChars,
							byte_count: contentBytes,
							content_sha256: contentHash,
							is_bulk: sqlAnalysis?.isBulk ?? false,
							source: "mcp" as const,
							verified: true,
							hash_match: true,
							lix_id: observation.lixId,
							repository_id: observation.lixId,
							organization_id: undefined,
						};

						lixrTelemetry.captureFileWritten(writeProps);

						if (!importSession.firstFileAdded) {
							importSession.firstFileAdded = true;
							lixrTelemetry.captureFirstFileAdded(writeProps);
						}
					}
				}

				// Add file content size to observation for $mcp_tool_call eventProperties
				if (totalContentChars > 0) {
					observation.fileContentCharCount = totalContentChars;
					observation.fileContentByteCount = totalContentBytes;
				}
			}

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
		const posthogToken = resolveOfficialMcpPosthogToken(env, {
			isDemo: authResult.auth.isDemo,
		});
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
			if (lixrTelemetry) {
				if (importSession.fileWrites.size > 0) {
					lixrTelemetry.captureImportCompleted({
						file_count: importSession.fileWrites.size,
						char_count: importSession.totalChars,
						byte_count: importSession.totalBytes,
						tool_call_count: importSession.toolCallCount,
						duration_ms: Date.now() - importSession.startTime,
						is_bulk: importSession.fileWrites.size > 1,
						lix_id: importSession.lixId,
						repository_id: importSession.lixId,
					});
				}
				const flushWork = lixrTelemetry.flush().catch((caught: unknown) => {
					console.warn("Failed to flush Lixr MCP telemetry", caught);
				});
				executionContext.waitUntil(flushWork);
			}
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
		const serverTimings: ServerTimingMetric[] = [];
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
		const publicPath =
			(endpoint === "file" || endpoint === "published-directory"
				? url.searchParams.get("path")
				: request.headers.get("x-lixray-public-path")) ?? undefined;

		const authenticate = options.authenticate ?? authenticateWithSupabase;
		const authCheckStartedAt = performance.now();
		if (bearerToken(request)) {
			const authResult = await measureServerTiming(
				serverTimings,
				"lixray-web-auth",
				() => authenticate(request, env),
			);
			if (authResult.ok) {
				const resolution = await measureServerTiming(
					serverTimings,
					"lixray-web-resolve",
					() =>
						(options.resolveLix ?? resolveLixWithSupabase)(
							namespace,
							lixSlug,
							authResult.auth,
							env,
						),
				);
				if (resolution.ok) {
					const response = await measureServerTiming(
						serverTimings,
						"lixray-server-roundtrip",
						() =>
							fetchLixRequest(
								resolution.lixId,
								request,
								protocolPath,
								env,
								options,
								authResult.auth.userId,
							),
					);
					return withServerTimings(response, serverTimings);
				}
				// A signed-in non-member falls through to the public read
				// transport instead of a dead end.
				if (!publicReadRequest) {
					return withServerTimings(resolution.response, serverTimings);
				}
			} else {
				// A bearer token was supplied but could not be authenticated. Do not
				// downgrade this request to public transport: an expired token must
				// remain distinguishable from a valid non-member public reader.
				return withServerTimings(authResult.response, serverTimings);
			}
		} else if (!publicReadRequest) {
			serverTimings.push({
				name: "lixray-web-auth",
				durationMs: performance.now() - authCheckStartedAt,
			});
			return withServerTimings(unauthorized().response, serverTimings);
		}

		const publicResolution = await measureServerTiming(
			serverTimings,
			"lixray-web-resolve",
			() =>
				(options.resolvePublicLix ?? resolvePublicLixWithSupabase)(
					namespace,
					lixSlug,
					env,
					publicPath,
				),
		);
		if (!publicResolution.ok) {
			return withServerTimings(publicResolution.response, serverTimings);
		}
		if (
			publicResolution.scope === "path" &&
			!(
				!endpoint ||
				endpoint === "session" ||
				endpoint === "file" ||
				endpoint === "published-directory"
			)
		) {
			return withServerTimings(lixNotFound().response, serverTimings);
		}
		if (endpoint === "published-directory") {
			if (!publicPath || !options.lixFetch) {
				return withServerTimings(lixNotFound().response, serverTimings);
			}
			try {
				const listing = await measureServerTiming(
					serverTimings,
					"lixray-server-roundtrip",
					() =>
						listPublishedDirectory(
							publicResolution.lixId,
							publicPath,
							env,
							options.lixFetch as NonNullable<HandleRequestOptions["lixFetch"]>,
							request.signal,
						),
				);
				return withServerTimings(json(listing), serverTimings);
			} catch (caught) {
				console.error("Unable to list a published directory", caught);
				return withServerTimings(
					new Response("Published directory is unavailable\n", { status: 502 }),
					serverTimings,
				);
			}
		}
		const mutationRejection = await rejectPublicMutation(request, endpoint);
		if (mutationRejection) {
			return withServerTimings(mutationRejection, serverTimings);
		}
		const response = await measureServerTiming(
			serverTimings,
			"lixray-server-roundtrip",
			() =>
				fetchLixRequest(
					publicResolution.lixId,
					request,
					protocolPath,
					env,
					options,
				),
		);
		return withServerTimings(response, serverTimings);
	}

	return (
		options.fallback?.(request, env) ??
		new Response("Not found\n", { status: 404 })
	);
}

async function measureServerTiming<T>(
	metrics: ServerTimingMetric[],
	name: ServerTimingMetric["name"],
	operation: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	try {
		return await operation();
	} finally {
		metrics.push({ name, durationMs: performance.now() - startedAt });
	}
}

function withServerTimings(
	response: Response,
	metrics: readonly ServerTimingMetric[],
): Response {
	if (metrics.length === 0) return response;
	const headers = new Headers(response.headers);
	const durationsByName = new Map<ServerTimingMetric["name"], number>();
	for (const { name, durationMs } of metrics) {
		durationsByName.set(name, (durationsByName.get(name) ?? 0) + durationMs);
	}
	const measured = [...durationsByName]
		.map(([name, durationMs]) => `${name};dur=${durationMs.toFixed(3)}`)
		.join(", ");
	const existing = headers.get("Server-Timing");
	headers.set(
		"Server-Timing",
		existing ? `${existing}, ${measured}` : measured,
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
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
	if (origin && !isTrustedProdDevAuthOrigin(request, origin)) {
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

/**
 * Same-site CSRF check for the production developer password grant.
 *
 * `request.url` behind Cloudflare/Railway is often the internal service
 * host (and may be `http:`), while the browser sends
 * `Origin: https://lixray.com`. Accept the public production origin and
 * a matching forwarded host/proto, but never an arbitrary third-party
 * Origin — even if `X-Forwarded-Host` is spoofed.
 */
function isTrustedProdDevAuthOrigin(request: Request, origin: string): boolean {
	const trusted = new Set<string>([
		new URL(request.url).origin,
		PUBLIC_PRODUCTION_ORIGIN,
	]);
	const forwarded = originFromForwardedHeaders(request);
	if (forwarded) trusted.add(forwarded);
	return trusted.has(origin);
}

function originFromForwardedHeaders(request: Request): string | null {
	const host = firstForwardedValue(request.headers.get("x-forwarded-host"));
	const proto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
	if (!host || (proto !== "http" && proto !== "https")) return null;
	try {
		const origin = new URL(`${proto}://${host}`).origin;
		return origin === PUBLIC_PRODUCTION_ORIGIN ? origin : null;
	} catch {
		return null;
	}
}

function firstForwardedValue(value: string | null): string | null {
	const first = value?.split(",")[0]?.trim();
	return first && first.length > 0 ? first : null;
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
		const jwksUrl = env.SUPABASE_JWKS_URL ?? "";
		const cachePath = env.LIXRAY_JWKS_CACHE_PATH?.trim() || undefined;
		const { payload } = await jwtVerify(
			token,
			await getRemoteJwks(jwksUrl, { cachePath }),
			{
				algorithms: ["ES256"],
				issuer,
				audience: "authenticated",
			},
		);
		await persistRemoteJwksIfPresent(jwksUrl, cachePath);
		if (!validateBrowserJwtClaims(payload)) return unauthorized();
		return {
			ok: true,
			auth: { userId: payload.sub as string, token },
		};
	} catch (error) {
		if (classifyJwtVerifyError(error) === "jwks_unavailable") {
			return jwksUnavailable();
		}
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
		const cachePath = env.LIXRAY_JWKS_CACHE_PATH?.trim() || undefined;
		const { payload } = await jwtVerify(
			token,
			await getRemoteJwks(env.SUPABASE_JWKS_URL, { cachePath }),
			{
				algorithms: ["ES256"],
				issuer,
				audience: "authenticated",
			},
		);
		await persistRemoteJwksIfPresent(env.SUPABASE_JWKS_URL, cachePath);
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
	} catch (error) {
		if (classifyJwtVerifyError(error) === "jwks_unavailable") {
			return {
				ok: false,
				response: mcpJwksUnavailableResponse(),
			};
		}
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

function lixNotFound(): { ok: false; response: Response } {
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
	publicPath?: string,
): Promise<PublicLixResolution> {
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
				...(publicPath ? { p_path: publicPath } : {}),
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
		const candidate: unknown =
			Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
		if (!candidate || typeof candidate !== "object") return lixNotFound();
		const row = candidate as Record<string, unknown>;
		const lixId = lixRowId(row);
		if (typeof lixId !== "string" || !lixId) {
			return lixNotFound();
		}
		if ("visibility" in row && row.visibility === "public") {
			return { ok: true, lixId, scope: "repository" };
		}
		if (publicPath && "path_public" in row && row.path_public === true) {
			return { ok: true, lixId, scope: "path" };
		}
		return lixNotFound();
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
	if (endpoint === "published-directory") return request.method === "GET";
	if (isPublicSyncReadRequest(request, endpoint)) return true;
	return (
		request.method === "POST" &&
		["execute", "execute-batch", "observe", "observe/multiplex"].includes(
			endpoint,
		)
	);
}

type PublishedDirectoryEntry = {
	path: string;
	kind: "file" | "directory";
};

/**
 * A path publication must not turn into a general-purpose SQL capability.
 * This server-owned query exposes only the direct file/directory names below
 * the already-authorized directory. Descendant authorization remains dynamic:
 * opening any returned child resolves it against the directory publication.
 */
async function listPublishedDirectory(
	lixId: string,
	directoryPath: string,
	env: WorkerEnv,
	lixFetch: NonNullable<HandleRequestOptions["lixFetch"]>,
	signal: AbortSignal,
): Promise<{ entries: PublishedDirectoryEntry[]; truncated: boolean }> {
	const client = new WorkerLixRuntimeClient(
		env,
		{ userId: LIX_ANONYMOUS_ACCOUNT_ID, token: "" },
		() => Promise.resolve(null),
		{ lixFetch, signal },
	);
	try {
		const result = await client.execute(lixId, {
			sql: `
WITH published_directory AS (
  SELECT id FROM lix_directory WHERE path = $1 LIMIT 1
)
SELECT path, 'file' AS kind
FROM lix_file
WHERE directory_id = (SELECT id FROM published_directory)
UNION ALL
SELECT path, 'directory' AS kind
FROM lix_directory
WHERE parent_id = (SELECT id FROM published_directory)
ORDER BY path
LIMIT 1001`,
			params: [{ kind: "text", value: directoryPath }],
		});
		const pathColumn = result.columns.indexOf("path");
		const kindColumn = result.columns.indexOf("kind");
		if (pathColumn === -1 || kindColumn === -1) {
			throw new Error("Published directory query returned unexpected columns.");
		}
		const entries = result.rows.flatMap((row): PublishedDirectoryEntry[] => {
			const path = row[pathColumn];
			const kind = row[kindColumn];
			if (
				path?.kind !== "text" ||
				kind?.kind !== "text" ||
				(kind.value !== "file" && kind.value !== "directory")
			) {
				return [];
			}
			return [{ path: path.value, kind: kind.value }];
		});
		return {
			entries: entries.slice(0, 1000),
			truncated: entries.length > 1000,
		};
	} finally {
		await client.close();
	}
}

function isPublicSyncReadRequest(request: Request, endpoint: string): boolean {
	return (
		request.method === "GET" &&
		["sync/pull", "sync/history", "sync/blob", "sync/chunk"].includes(endpoint)
	);
}

/**
 * The canonical Lix protocol has no read-only mode, so the service
 * is the authorization boundary for public readers: every SQL string in a
 * public request must classify as a read. Classification is a SELECT/VALUES
 * prefix check plus a write-verb regex (INSERT/UPDATE/DELETE). A mutation
 * cannot hide behind a multi-statement script because those verbs are matched
 * anywhere in the string. Empty or unreadable bodies fail closed.
 */
async function rejectPublicMutation(
	request: Request,
	endpoint: string,
): Promise<Response | null> {
	if (
		!endpoint ||
		endpoint === "session" ||
		(endpoint === "file" && request.method === "GET") ||
		isPublicSyncReadRequest(request, endpoint)
	) {
		return null;
	}
	let statements: Array<string>;
	try {
		statements = await publicSqlStatements(request, endpoint);
	} catch {
		return publicReadOnlyResponse();
	}
	if (statements.length === 0) {
		return publicReadOnlyResponse();
	}
	if (!statements.every((sql) => isClearlyReadOnlySql(sql))) {
		return publicReadOnlyResponse();
	}
	return null;
}

async function publicSqlStatements(
	request: Request,
	endpoint: string,
): Promise<Array<string>> {
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
		const { sql } = entry as Record<string, unknown>;
		if (typeof sql !== "string" || sql.length === 0) {
			throw new Error("Malformed public statement");
		}
		return sql;
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
	return isDemoEnvironment(env);
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

function jwksUnavailable(): Extract<AuthResult, { ok: false }> {
	return {
		ok: false,
		response: new Response("Authentication is temporarily unavailable\n", {
			status: 503,
		}),
	};
}

function mcpJwksUnavailableResponse(): Response {
	return new Response("MCP authentication is temporarily unavailable\n", {
		status: 503,
		headers: {
			"access-control-allow-origin": "*",
			"retry-after": "2",
		},
	});
}

export async function warmJwtVerifier(
	env: Pick<WorkerEnv, "SUPABASE_JWKS_URL" | "LIXRAY_JWKS_CACHE_PATH">,
): Promise<void> {
	const jwksUrl = env.SUPABASE_JWKS_URL?.trim();
	if (!jwksUrl) return;
	await warmRemoteJwks(jwksUrl, {
		cachePath: env.LIXRAY_JWKS_CACHE_PATH?.trim() || undefined,
	});
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
