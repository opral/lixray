import { handlePublishedEntity, type EntityKind } from "./published-entity.ts";
import { deleteHostedRepository } from "./repository-delete.ts";
import { handleFileSharing } from "./repository-file-sharing.ts";
import { createHostedRepository } from "./repository-create.ts";
import { validateMcpJwtClaims } from "../mcp/auth.ts";
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
	DEMO_PROFILE_NAMESPACE_ID,
	demoProfileDocument,
	DEMO_LIX_ID,
	DEMO_LIX_NAME,
	DEMO_SECONDARY_LIX_ID,
	DEMO_SECONDARY_LIX_NAME,
} from "../lib/demo-identity.ts";
import { isClearlyReadOnlySql } from "../lib/lix-sql-access.ts";
import {
	aggregatePublicProfileActivity,
	type ProfileRepositoryFiles,
	type ProfileRepositorySource,
} from "../lib/profile-activity-aggregate.ts";
import { WorkerLixRuntimeClient } from "../mcp/runtime-client.ts";
import { LixService, type LixSummary } from "../mcp/lix-service.ts";
import {
	aiTraceContextForMcpRequest,
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
	type McpRequestObservation,
} from "./mcp-telemetry.ts";
import {
	createLixrMcpTelemetrySession,
	analyzeSqlOperation,
	detectFileWrites,
	computeContentHash,
	getFileExtension,
} from "./lixr-mcp-telemetry.ts";
import { resolveSupabaseLixId } from "./lix-resolver.ts";
import { authorizeApiToken } from "./api-token.ts";
import {
	provisionAccountAfterHandshake,
	type LixAccountProfile,
} from "../mcp/lix-account-provisioning.ts";
import {
	isDemoEnvironment,
	resolveOfficialMcpPosthogToken,
} from "./mcp-posthog-env.ts";
import {
	SIGNUP_TELEMETRY_PATH,
	type SignupTelemetryContext,
} from "../lib/signup-telemetry.ts";
import {
	captureUserSignedUp,
	type SignupTelemetryResult,
} from "./signup-telemetry.ts";
import {
	PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS,
	PublicProfileActivityCache,
} from "./profile-activity-cache.ts";
import { handleOtlpTelemetry } from "./otlp-telemetry.ts";

export { validateMcpJwtClaims } from "../mcp/auth.ts";

export interface WorkerEnv {
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	/** Server-only credential for registering protocol-created repository ownership. */
	SUPABASE_SERVICE_ROLE_KEY?: string;
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
	resolvePublicLix?: ResolvePublicLix;
	resolveNamespaceProfile?: ResolveNamespaceProfile;
	resolvePublicProfileRepositories?: ResolvePublicProfileRepositories;
	profileActivityCache?: PublicProfileActivityCache | null;
	resolveNamespaceMembership?: (
		namespaceId: string,
		accessToken: string,
		env: WorkerEnv,
	) => Promise<NamespaceMembershipResolution>;
	mcpTransport?: typeof handleMcpTransport;
	lixFetch?: (lixId: string, request: Request) => Promise<Response>;
	lixSummaries?: ReadonlyArray<LixSummary>;
	fallback?: (request: Request, env: WorkerEnv) => Promise<Response>;
	fetch?: typeof fetch;
	executionContext?: RequestExecutionContext;
	createMcpTelemetry?: typeof createMcpTelemetrySession;
	recordMcpLixConnection?: RecordMcpLixConnection;
	captureSignup?: typeof captureUserSignedUp;
}

const publicProfileActivityCache = new PublicProfileActivityCache();
const PUBLIC_PROFILE_ACTIVITY_TIMEOUT_MS = 30_000;

interface AuthenticatedUser {
	/** Canonical LixRay account ID, never the Supabase auth user ID. */
	userId: string;
	/** The credential ID in auth.users for checks against Supabase Auth. */
	authUserId?: string;
	token: string;
	account?: LixAccountProfile;
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

/**
 * Resolves a live lix for the public read transport. This deliberately
 * does not use the member-scoped lix lookup: a valid browser JWT alone
 * must never turn a public reader into an editor.
 */
type ResolvePublicLix = (
	lixId: string,
	env: WorkerEnv,
	publicPath?: string,
) => Promise<PublicLixResolution>;

type PublicLixResolution =
	| { ok: true; lixId: string; scope?: "repository" | "path" }
	| { ok: false; response: Response };

type LixResolution = PublicLixResolution;

export type ResolveNamespaceProfile = (
	namespaceId: string,
	env: WorkerEnv,
) => Promise<NamespaceProfileResolution>;

type NamespaceProfileResolution =
	| { ok: true; document: Record<string, unknown>; updatedAt: string }
	| { ok: false; response: Response };

export type ResolvePublicProfileRepositories = (
	namespaceId: string,
	env: WorkerEnv,
) => Promise<PublicProfileRepositoriesResolution>;

type PublicProfileRepositoriesResolution =
	| { ok: true; repositories: Array<ProfileRepositorySource> }
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

const REMOTE_LIX_API_PATH =
	/^\/lix\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(.*))?$/;
const PUBLISHED_LIX_DIRECTORY_PATH =
	/^\/api\/published\/lix\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/directory$/;
const PROD_DEV_AUTH_PATH = "/auth/email";
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const OPENAI_APPS_CHALLENGE_TOKEN =
	"RBTbX7uPYZwmyPGnWXM2eMruvkdC6MlM3Xsh95AqROU";
const PROD_DEV_EMAIL = "dev@lixray.com";
const PUBLIC_PRODUCTION_ORIGIN = "https://lixray.com";
const NAMESPACE_PROFILE_PATH = /^\/profile\/([^/]+)$/;
const NAMESPACE_PROFILE_ACTIVITY_PATH = /^\/profile\/([^/]+)\/activity$/;
const NAMESPACE_PROFILE_ACTIVITY_REFRESH_PATH =
	/^\/profile\/([^/]+)\/activity\/refresh$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";
// Keep server-owned public reads attributed to Lix's built-in anonymous
// account. Protocol principals are persisted as lix_account IDs, so an
// arbitrary service label is not valid here.
const LIX_ANONYMOUS_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

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

	if (url.pathname === "/api/telemetry/otlp/v1/traces") {
		return handleOtlpTelemetry(request, env);
	}

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

	if (url.pathname === "/api/published/entity") {
		return handlePublishedEntity(
			request,
			env,
			(lixId, kind, selector) =>
				lookupLiveEntity(lixId, kind, selector, env, options, request.signal),
			async (lixId, path) =>
				(
					await (options.resolvePublicLix ?? resolvePublicLixWithSupabase)(
						lixId,
						env,
						path,
					)
				).ok,
			options.fetch,
		);
	}

	const fileShareMatch = /^\/api\/repositories\/([0-9a-f-]{36})\/share$/.exec(
		url.pathname,
	);
	if (fileShareMatch) {
		const auth = await (
			options.authenticate ??
			((request, env) =>
				authenticateRepositoryClient(request, env, options.fetch))
		)(request, env);
		if (!auth.ok) return auth.response;
		return handleFileSharing(
			request,
			env,
			auth.auth.token,
			fileShareMatch[1],
			options.fetch,
			async (path) =>
				(
					await lookupLiveEntity(
						fileShareMatch[1],
						"file",
						{ path },
						env,
						options,
						request.signal,
					)
				)?.id ?? null,
		);
	}

	if (url.pathname === "/api/account" && request.method === "GET") {
		const token = bearerToken(request);
		if (!token) return new Response("API token required", { status: 401 });
		const result = await authorizeApiToken(token, null, env, options.fetch);
		return result.ok
			? Response.json(
					{ id: result.account.id, name: result.account.name },
					{ headers: { "cache-control": "no-store" } },
				)
			: result.response;
	}

	if (url.pathname === "/lix/v1") {
		if (request.method === "OPTIONS") return remoteLixCorsPreflight(request);
		if (request.method !== "POST")
			return new Response("Method not allowed", { status: 405 });
		const auth = await (
			options.authenticate ??
			((request, env) =>
				authenticateRepositoryClient(request, env, options.fetch))
		)(request, env);
		if (!auth.ok) return withRemoteLixCors(auth.response, request);
		if (auth.auth.isDemo)
			return new Response("Sign in to create a repository", { status: 403 });
		return withRemoteLixCors(
			await createHostedRepository(request, env, auth.auth, options.fetch),
			request,
		);
	}

	const namespaceProfileActivityRefreshMatch =
		NAMESPACE_PROFILE_ACTIVITY_REFRESH_PATH.exec(url.pathname);
	if (namespaceProfileActivityRefreshMatch) {
		if (request.method === "OPTIONS") return profileCorsPreflight();
		if (request.method !== "POST") {
			return profileResponse("Method not allowed\n", {
				status: 405,
				headers: { Allow: "POST, OPTIONS" },
			});
		}
		const namespaceId = safeDecodeURIComponent(
			namespaceProfileActivityRefreshMatch[1],
		)?.toLowerCase();
		if (!namespaceId || !UUID_PATTERN.test(namespaceId)) {
			return profileResponse("Profile not found\n", { status: 404 });
		}
		if (isDemoMode(env)) return profileResponse(null, { status: 204 });
		const token = bearerToken(request);
		if (!token) {
			return profileResponse("Authentication required\n", { status: 401 });
		}
		const membership = await (options.resolveNamespaceMembership
			? options.resolveNamespaceMembership(namespaceId, token, env)
			: resolveNamespaceMembershipWithSupabase(namespaceId, token, env));
		if (!membership.ok) return withProfileCors(membership.response);
		if (!membership.member) {
			return profileResponse("Membership required\n", { status: 403 });
		}
		const refreshCache =
			options.profileActivityCache === undefined
				? publicProfileActivityCache
				: options.profileActivityCache;
		refreshCache?.invalidate(namespaceId);
		return profileResponse(null, { status: 204 });
	}

	const namespaceProfileActivityMatch = NAMESPACE_PROFILE_ACTIVITY_PATH.exec(
		url.pathname,
	);
	if (namespaceProfileActivityMatch) {
		if (request.method === "OPTIONS") return profileCorsPreflight();
		if (request.method !== "GET" && request.method !== "HEAD") {
			return profileResponse("Method not allowed\n", {
				status: 405,
				headers: { Allow: "GET, HEAD, OPTIONS" },
			});
		}
		const namespaceId = safeDecodeURIComponent(
			namespaceProfileActivityMatch[1],
		)?.toLowerCase();
		if (!namespaceId || !UUID_PATTERN.test(namespaceId)) {
			return profileResponse("Profile not found\n", { status: 404 });
		}
		const resolution = await (options.resolvePublicProfileRepositories
			? options.resolvePublicProfileRepositories(namespaceId, env)
			: isDemoMode(env)
				? resolveDemoPublicProfileRepositories(namespaceId)
				: resolvePublicProfileRepositoriesWithSupabase(namespaceId, env));
		if (!resolution.ok) return withProfileCors(resolution.response);
		const loadActivity = async () => ({
			...(await loadPublicProfileActivity(
				resolution.repositories,
				env,
				options.lixFetch,
				AbortSignal.timeout(PUBLIC_PROFILE_ACTIVITY_TIMEOUT_MS),
			)),
			computedAt: new Date().toISOString(),
		});
		const activityCache =
			options.profileActivityCache === undefined
				? publicProfileActivityCache
				: options.profileActivityCache;
		const activity = activityCache
			? await activityCache.resolve(namespaceId, loadActivity)
			: await loadActivity();
		return profileActivityResponse(request, activity);
	}

	const namespaceProfileMatch = NAMESPACE_PROFILE_PATH.exec(url.pathname);
	if (namespaceProfileMatch) {
		if (request.method === "OPTIONS") return profileCorsPreflight();
		if (request.method !== "GET" && request.method !== "HEAD") {
			return profileResponse("Method not allowed\n", {
				status: 405,
				headers: { Allow: "GET, HEAD, OPTIONS" },
			});
		}
		const namespaceId = safeDecodeURIComponent(
			namespaceProfileMatch[1],
		)?.toLowerCase();
		if (!namespaceId || !UUID_PATTERN.test(namespaceId)) {
			return profileResponse("Profile not found\n", { status: 404 });
		}
		const resolution = await (options.resolveNamespaceProfile
			? options.resolveNamespaceProfile(namespaceId, env)
			: isDemoMode(env)
				? resolveDemoNamespaceProfile(namespaceId, url.origin)
				: resolveNamespaceProfileWithSupabase(namespaceId, env));
		if (!resolution.ok) return withProfileCors(resolution.response);
		return resolvedProfileResponse(request, namespaceId, resolution);
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

	if (url.pathname === SIGNUP_TELEMETRY_PATH) {
		return handleSignupTelemetry(request, env, options);
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
		const startedAt = performance.now();
		const incomingTrace = aiTraceContextForMcpRequest(request);
		const traceContext = {
			...incomingTrace,
			traceId: incomingTrace.traceId ?? crypto.randomUUID(),
		};
		let telemetry: McpTelemetrySession | null = null;
		let cleanupOwnsFlush = false;
		let observed = false;
		let stage: McpRequestObservation["stage"] = "authentication";
		const initializeTelemetry = (
			identity: Parameters<typeof createMcpTelemetrySession>[1],
		): void => {
			try {
				telemetry = (options.createMcpTelemetry ?? createMcpTelemetrySession)(
					env,
					identity,
				);
			} catch {
				// Telemetry must never change the result of an MCP request.
			}
		};
		const onTransport = (observation: McpRequestObservation): void => {
			if (observed) return;
			observed = true;
			try {
				telemetry?.onTransport?.(observation);
			} catch {
				/* best effort */
			}
		};
		const captureFailure = (statusCode: number, errorCode: string): void => {
			// Only authenticated requests have a telemetry session. Auth challenges
			// and retries must not create billable AI traces or anonymous people.
			if (!telemetry) return;
			onTransport({
				requestId,
				...traceContext,
				durationMs: performance.now() - startedAt,
				statusCode,
				outcome: "error",
				errorCode,
				stage,
			});
		};
		const internalError = (): Response =>
			withMcpRequestId(
				json(
					{
						jsonrpc: "2.0",
						id: null,
						error: {
							code: -32603,
							message: `Internal error (request_id: ${requestId})`,
							data: { request_id: requestId },
						},
					},
					{ status: 500 },
				),
				requestId,
			);
		try {
			const authenticateMcp =
				options.authenticateMcp ?? authenticateMcpWithSupabase;
			const authResult = await authenticateMcp(request, env);
			if (!authResult.ok) {
				captureFailure(authResult.response.status, "MCP_AUTHENTICATION_FAILED");
				return withMcpRequestId(authResult.response, requestId);
			}
			stage = "setup";
			initializeTelemetry({
				userId: authResult.auth.userId,
				clientId: authResult.auth.clientId,
				isDemo: authResult.auth.isDemo,
			});
			const authorizeLix = options.authorizeLix ?? authorizeLixWithSupabase;
			// This positive cache is recreated for every MCP HTTP request.
			const authorizedLixIds = new Set<string>();
			if (!options.lixFetch) {
				captureFailure(500, "MCP_STORAGE_NOT_CONFIGURED");
				return internalError();
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

				try {
					telemetry?.onToolCall(observation);
				} catch {
					/* best effort */
				}

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
				await Promise.allSettled(pendingConnectionRecords);
				scheduleMcpTelemetryFlush(executionContext, telemetry);
				try {
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
				} catch (error) {
					console.warn("Failed to finalize Lixr MCP telemetry", {
						requestId,
						error,
					});
				}
				try {
					await client.close();
				} catch (error) {
					console.warn("Failed to close MCP runtime client", {
						requestId,
						error,
					});
				}
			};
			cleanupOwnsFlush = true;
			try {
				const service = new LixService(client, {
					contextSigningKey: env.LIXRAY_CONTEXT_SIGNING_KEY,
					principal: {
						userId: authResult.auth.userId,
						clientId: authResult.auth.clientId,
					},
				});
				stage = "transport";
				const response = withMcpRequestId(
					await (options.mcpTransport ?? handleMcpTransport)(request, service, {
						authMode: isDemoMode(env) ? "none" : "oauth",
						requestId,
						traceContext,
						onTransport,
						onToolCall,
						posthogToken,
						posthogHost: env.POSTHOG_HOST,
						posthogDistinctId: authResult.auth.userId,
						posthogClientId: authResult.auth.clientId,
						onPosthogFlush,
					}),
					requestId,
				);
				if (response.status >= 400)
					captureFailure(response.status, `HTTP_${response.status}`);
				if (isStreamingMcpResponse(response)) {
					responseCleanupDeferred = true;
					return deferResponseCleanup(response, cleanup);
				}
				return response;
			} catch (error) {
				console.error("MCP request failed", { requestId, stage, error });
				captureFailure(
					500,
					stage === "setup" ? "MCP_SETUP_FAILED" : "MCP_TRANSPORT_FAILED",
				);
				return internalError();
			} finally {
				if (!responseCleanupDeferred) await cleanup();
			}
		} catch (error) {
			console.error("MCP request failed", { requestId, stage, error });
			captureFailure(
				500,
				stage === "authentication"
					? "MCP_AUTHENTICATION_FAILED"
					: "MCP_SETUP_FAILED",
			);
			return internalError();
		} finally {
			if (!cleanupOwnsFlush)
				scheduleMcpTelemetryFlush(executionContext, telemetry);
		}
	}

	const publishedLixDirectoryMatch = PUBLISHED_LIX_DIRECTORY_PATH.exec(
		url.pathname,
	);
	if (publishedLixDirectoryMatch) {
		if (request.method !== "GET") {
			return new Response("Method not allowed\n", { status: 405 });
		}
		const lixId = publishedLixDirectoryMatch[1];
		const publicPath = url.searchParams.get("path") ?? undefined;
		if (!publicPath || !options.lixFetch) return lixNotFound().response;
		const publicResolution = await (
			options.resolvePublicLix ?? resolvePublicLixWithSupabase
		)(lixId, env, publicPath);
		if (!publicResolution.ok) return publicResolution.response;
		try {
			return json(
				await listPublishedDirectory(
					publicResolution.lixId,
					publicPath,
					env,
					options.lixFetch,
					request.signal,
				),
			);
		} catch (caught) {
			console.error("Unable to list a published directory", caught);
			return new Response("Published directory is unavailable\n", {
				status: 502,
			});
		}
	}

	const remoteLixMatch = REMOTE_LIX_API_PATH.exec(url.pathname);
	if (remoteLixMatch) {
		if (request.method === "OPTIONS") return remoteLixCorsPreflight(request);
		if (
			request.method === "DELETE" &&
			!remoteLixMatch[2]?.replace(/\/+$/, "")
		) {
			const auth = await (
				options.authenticate ??
				((request, env) =>
					authenticateRepositoryClient(request, env, options.fetch))
			)(request, env);
			if (!auth.ok) return withRemoteLixCors(auth.response, request);
			if (auth.auth.isDemo)
				return withRemoteLixCors(
					new Response("Sign in to delete a repository", { status: 403 }),
					request,
				);
			return withRemoteLixCors(
				await deleteHostedRepository(
					request,
					remoteLixMatch[1],
					env,
					auth.auth,
					options.fetch,
				),
				request,
			);
		}
		const response = await (async () => {
			const serverTimings: ServerTimingMetric[] = [];
			const lixId = remoteLixMatch[1];
			const endpoint = remoteLixMatch[2]?.replace(/\/+$/, "") ?? "";
			const protocolPath = `/lix/v1/${lixId}${endpoint ? `/${endpoint}` : "/"}`;
			const apiToken = bearerToken(request);
			if (apiToken?.startsWith("lixray_pat_")) {
				const result = await authorizeApiToken(
					apiToken,
					lixId,
					env,
					options.fetch,
				);
				if (!result.ok) return result.response;
				return fetchLixRequest(
					lixId,
					request,
					protocolPath,
					env,
					options,
					result.account.id,
					result.account,
				);
			}
			const publicReadRequest = isPublicReadRemoteLixRequest(request, endpoint);
			const publicPath =
				(endpoint === "file"
					? url.searchParams.get("path")
					: request.headers.get("x-lixray-public-path")) ?? undefined;

			const authenticate = options.authenticate ?? authenticateRepositoryClient;
			const authorizeLix = options.authorizeLix ?? authorizeLixWithSupabase;
			const authCheckStartedAt = performance.now();
			if (bearerToken(request)) {
				const authResult = await measureServerTiming(
					serverTimings,
					"lixray-web-auth",
					() => authenticate(request, env),
				);
				if (authResult.ok) {
					const authorizationFailure = await measureServerTiming(
						serverTimings,
						"lixray-web-resolve",
						() => authorizeLix(lixId, authResult.auth, env),
					);
					if (authorizationFailure === null) {
						const response = await measureServerTiming(
							serverTimings,
							"lixray-server-roundtrip",
							() =>
								fetchLixRequest(
									lixId,
									request,
									protocolPath,
									env,
									options,
									authResult.auth.userId,
									authResult.auth.account,
								),
						);
						return withServerTimings(response, serverTimings);
					}
					// A signed-in non-member falls through to the public read
					// transport instead of a dead end.
					if (!publicReadRequest) {
						return withServerTimings(authorizationFailure, serverTimings);
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
						lixId,
						env,
						publicPath,
					),
			);
			if (!publicResolution.ok) {
				return withServerTimings(publicResolution.response, serverTimings);
			}
			if (
				publicResolution.scope === "path" &&
				!(!endpoint || endpoint === "session" || endpoint === "file")
			) {
				return withServerTimings(lixNotFound().response, serverTimings);
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
		})();
		return withRemoteLixCors(response, request);
	}

	return (
		options.fallback?.(request, env) ??
		new Response("Not found\n", { status: 404 })
	);
}

async function handleSignupTelemetry(
	request: Request,
	env: WorkerEnv,
	options: HandleRequestOptions,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed\n", { status: 405 });
	}
	const authResult = await (options.authenticate ?? authenticateWithSupabase)(
		request,
		env,
	);
	if (!authResult.ok) return authResult.response;

	let context: SignupTelemetryContext;
	try {
		const body: unknown = await request.json();
		if (!body || typeof body !== "object") throw new Error("invalid body");
		const candidate = body as Record<string, unknown>;
		if (
			(candidate.surface !== "web" && candidate.surface !== "mcp") ||
			(candidate.source !== "direct" &&
				candidate.source !== "oauth" &&
				candidate.source !== "other")
		) {
			throw new Error("invalid context");
		}
		context = { surface: candidate.surface, source: candidate.source };
	} catch {
		return json({ error: "Invalid signup telemetry context" }, { status: 400 });
	}

	const result: SignupTelemetryResult = await (
		options.captureSignup ?? captureUserSignedUp
	)(env, authResult.auth, context, { fetch: options.fetch ?? fetch });
	if (result === "failed") {
		return json({ captured: false }, { status: 502 });
	}
	return json(
		{ captured: result === "captured" },
		{ headers: { "cache-control": "no-store" } },
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
	account?: LixAccountProfile,
): Promise<Response> {
	const rewrittenRequest = rewriteLixRequest(
		request,
		protocolPath,
		trustedPrincipal,
	);
	const lixFetch = options.lixFetch;
	if (lixFetch) {
		const response = await lixFetch(lixId, rewrittenRequest);
		return provisionAccountAfterHandshake({
			lixId,
			protocolPath,
			response,
			account,
			lixFetch: (provisioningRequest) => lixFetch(lixId, provisioningRequest),
		});
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
		const account = await resolveCurrentAccount(token, env);
		if (!account.ok) return account;
		return {
			ok: true,
			auth: {
				userId: account.account.id,
				authUserId: payload.sub,
				token,
				account: account.account,
			},
		};
	} catch (error) {
		if (classifyJwtVerifyError(error) === "jwks_unavailable") {
			return jwksUnavailable();
		}
		return unauthorized();
	}
}

type CurrentAccountResolution =
	| { ok: true; account: LixAccountProfile }
	| { ok: false; response: Response };

/** Resolve one validated Supabase login to its canonical LixRay account. */
export async function resolveCurrentAccount(
	token: string,
	env: Pick<WorkerEnv, "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY">,
	fetchImpl: typeof fetch = fetch,
): Promise<CurrentAccountResolution> {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("Supabase Data API is not configured\n", {
				status: 500,
			}),
		};
	}
	const url = new URL("/rest/v1/rpc/current_account", env.SUPABASE_URL);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: "{}",
		});
	} catch {
		return {
			ok: false,
			response: new Response("Account resolution is unavailable\n", {
				status: 502,
			}),
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			response: new Response("Account resolution is unavailable\n", {
				status: 502,
			}),
		};
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	const row: unknown = Array.isArray(payload)
		? (payload as Array<unknown>)[0]
		: payload;
	const account = parseCurrentAccount(row);
	if (!account) {
		return {
			ok: false,
			response: new Response("LixRay account is unavailable\n", {
				status: 403,
			}),
		};
	}
	return { ok: true, account };
}

function parseCurrentAccount(value: unknown): LixAccountProfile | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	const id = row.account_id;
	const kind = row.kind;
	const name = row.name;
	const profileUri = row.profile_uri;
	if (
		typeof id !== "string" ||
		!UUID_PATTERN.test(id) ||
		typeof kind !== "string" ||
		kind.trim().length === 0 ||
		typeof name !== "string" ||
		name.trim().length === 0 ||
		(profileUri !== null &&
			(typeof profileUri !== "string" || !isAbsoluteHttpUrl(profileUri)))
	) {
		return null;
	}
	return { id, kind, name, profileUri };
}

function isAbsoluteHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
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

async function authenticateRepositoryClient(
	request: Request,
	env: WorkerEnv,
	fetcher: typeof fetch = fetch,
): Promise<AuthResult> {
	const token = bearerToken(request);
	if (token?.startsWith("lixray_pat_")) {
		const result = await authorizeApiToken(token, null, env, fetcher);
		return result.ok
			? {
					ok: true,
					auth: { userId: result.account.id, token, account: result.account },
				}
			: result;
	}
	return authenticateWithSupabase(request, env);
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
		const account = await resolveCurrentAccount(token, env);
		if (!account.ok) {
			return {
				ok: false,
				response:
					account.response.status === 403
						? mcpUnauthorizedResponse(
								"invalid_token",
								"Your login is not linked to a LixRay account.",
								protectedResourceUrl,
							)
						: account.response,
			};
		}
		return {
			ok: true,
			auth: {
				userId: account.account.id,
				authUserId: claims.userId,
				token,
				clientId: claims.clientId,
				account: account.account,
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

export type NamespaceMembershipResolution =
	| { ok: true; member: boolean }
	| { ok: false; response: Response };

/**
 * Checks whether the bearer of `accessToken` is a member of the namespace by
 * querying namespaces with the user's own token. Its access policy includes
 * both personal ownership and organization membership.
 */
export async function resolveNamespaceMembershipWithSupabase(
	namespaceId: string,
	accessToken: string,
	env: WorkerEnv,
): Promise<NamespaceMembershipResolution> {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("Supabase Data API is not configured\n", {
				status: 500,
			}),
		};
	}
	const lookupUrl = new URL("/rest/v1/namespaces", env.SUPABASE_URL);
	lookupUrl.searchParams.set("select", "id");
	lookupUrl.searchParams.set("id", `eq.${namespaceId}`);
	lookupUrl.searchParams.set("limit", "1");

	let response: Response;
	try {
		response = await fetch(lookupUrl, {
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});
	} catch {
		return {
			ok: false,
			response: new Response("Membership lookup is unavailable\n", {
				status: 503,
			}),
		};
	}
	if (response.status === 401 || response.status === 403) {
		return { ok: true, member: false };
	}
	if (!response.ok) {
		return {
			ok: false,
			response: new Response("Membership lookup is unavailable\n", {
				status: 503,
			}),
		};
	}
	try {
		const rows: unknown = await response.json();
		return { ok: true, member: Array.isArray(rows) && rows.length > 0 };
	} catch {
		return {
			ok: false,
			response: new Response("Membership lookup is unavailable\n", {
				status: 503,
			}),
		};
	}
}

export async function resolveNamespaceProfileWithSupabase(
	namespaceId: string,
	env: WorkerEnv,
): Promise<NamespaceProfileResolution> {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("Supabase Data API is not configured\n", {
				status: 500,
			}),
		};
	}

	const lookupUrl = new URL("/rest/v1/namespace_profiles", env.SUPABASE_URL);
	lookupUrl.searchParams.set("select", "document,updated_at");
	lookupUrl.searchParams.set("namespace_id", `eq.${namespaceId}`);
	lookupUrl.searchParams.set("limit", "1");

	let response: Response;
	try {
		response = await fetch(lookupUrl, {
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY,
				Accept: "application/json",
			},
		});
	} catch {
		return profileResolutionUnavailable();
	}
	if (!response.ok) return profileResolutionUnavailable();

	try {
		const rows: unknown = await response.json();
		if (!Array.isArray(rows)) return profileResolutionUnavailable();
		if (rows.length === 0) return profileNotFound();
		if (rows.length !== 1) return profileResolutionUnavailable();
		return namespaceProfileRow(rows[0]) ?? profileResolutionUnavailable();
	} catch {
		return profileResolutionUnavailable();
	}
}

export async function resolvePublicProfileRepositoriesWithSupabase(
	namespaceId: string,
	env: WorkerEnv,
): Promise<PublicProfileRepositoriesResolution> {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		return profileRepositoriesUnavailable();
	}
	const lookupUrl = new URL(
		"/rest/v1/rpc/list_public_profile_lixes",
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
			body: JSON.stringify({ p_namespace_id: namespaceId }),
		});
	} catch {
		return profileRepositoriesUnavailable();
	}
	if (!response.ok) return profileRepositoriesUnavailable();

	try {
		const rows: unknown = await response.json();
		if (!Array.isArray(rows)) return profileRepositoriesUnavailable();
		const repositories = rows.map(publicProfileRepositoryRow);
		if (repositories.some((repository) => repository === null)) {
			return profileRepositoriesUnavailable();
		}
		return {
			ok: true,
			repositories: repositories as Array<ProfileRepositorySource>,
		};
	} catch {
		return profileRepositoriesUnavailable();
	}
}

function resolveDemoPublicProfileRepositories(
	namespaceId: string,
): PublicProfileRepositoriesResolution {
	if (namespaceId !== DEMO_PROFILE_NAMESPACE_ID) {
		return profileRepositoriesNotFound();
	}
	return {
		ok: true,
		repositories: [
			{
				id: DEMO_LIX_ID,
				name: DEMO_LIX_NAME,
				slug: DEMO_LIX_NAME,
				namespaceHandle: DEMO_ORGANIZATION_NAME,
			},
		],
	};
}

async function loadPublicProfileActivity(
	repositories: Array<ProfileRepositorySource>,
	env: WorkerEnv,
	lixFetch: HandleRequestOptions["lixFetch"],
	signal: AbortSignal,
) {
	if (!lixFetch) {
		return aggregatePublicProfileActivity(
			repositories.map((repository) => ({ repository, paths: null })),
		);
	}
	const client = new WorkerLixRuntimeClient(
		env,
		{ userId: LIX_ANONYMOUS_ACCOUNT_ID, token: "" },
		() => Promise.resolve(null),
		{ lixFetch, signal },
	);
	try {
		const files = await mapWithConcurrency(
			repositories,
			4,
			async (repository): Promise<ProfileRepositoryFiles> => {
				try {
					const result = await client.execute(repository.id, {
						sql: "SELECT path FROM lix_file ORDER BY path",
					});
					const pathColumn = result.columns.indexOf("path");
					if (pathColumn === -1) return { repository, paths: null };
					return {
						repository,
						paths: result.rows.flatMap((row) => {
							const value = row[pathColumn];
							return value?.kind === "text" ? [value.value] : [];
						}),
					};
				} catch (error) {
					console.error(
						`[profile-activity] file listing failed for ${repository.slug}:`,
						error,
					);
					return { repository, paths: null };
				}
			},
		);
		return aggregatePublicProfileActivity(files);
	} finally {
		await client.close();
	}
}

function publicProfileRepositoryRow(
	value: unknown,
): ProfileRepositorySource | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	return typeof row.lix_id === "string" &&
		typeof row.lix_name === "string" &&
		typeof row.lix_slug === "string" &&
		typeof row.namespace_handle === "string"
		? {
				id: row.lix_id,
				name: row.lix_name,
				slug: row.lix_slug,
				namespaceHandle: row.namespace_handle,
			}
		: null;
}

async function mapWithConcurrency<Input, Output>(
	inputs: Array<Input>,
	concurrency: number,
	operation: (input: Input) => Promise<Output>,
): Promise<Array<Output>> {
	const results = new Array<Output>(inputs.length);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
			while (nextIndex < inputs.length) {
				const index = nextIndex;
				nextIndex += 1;
				results[index] = await operation(inputs[index]);
			}
		}),
	);
	return results;
}

function resolveDemoNamespaceProfile(
	namespaceId: string,
	origin: string,
): NamespaceProfileResolution {
	if (namespaceId !== DEMO_PROFILE_NAMESPACE_ID) return profileNotFound();
	return {
		ok: true,
		document: demoProfileDocument(origin),
		updatedAt: "2026-08-21T00:00:00.000Z",
	};
}

function namespaceProfileRow(
	value: unknown,
): NamespaceProfileResolution | null {
	if (!value || typeof value !== "object") return null;
	const row = value as { document?: unknown; updated_at?: unknown };
	if (
		!row.document ||
		typeof row.document !== "object" ||
		Array.isArray(row.document) ||
		typeof row.updated_at !== "string"
	) {
		return null;
	}
	const document = row.document as Record<string, unknown>;
	if (document["@type"] !== "Card" || document.version !== "2.0") return null;
	return { ok: true, document, updatedAt: row.updated_at };
}

function profileNotFound(): NamespaceProfileResolution {
	return {
		ok: false,
		response: new Response("Profile not found\n", { status: 404 }),
	};
}

function profileResolutionUnavailable(): NamespaceProfileResolution {
	return {
		ok: false,
		response: new Response("Profile resolution is unavailable\n", {
			status: 502,
		}),
	};
}

function profileRepositoriesNotFound(): PublicProfileRepositoriesResolution {
	return {
		ok: false,
		response: new Response("Profile not found\n", { status: 404 }),
	};
}

function profileRepositoriesUnavailable(): PublicProfileRepositoriesResolution {
	return {
		ok: false,
		response: new Response("Profile repositories are unavailable\n", {
			status: 502,
		}),
	};
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
 * Public resolution is deliberately separate from member authorization. It
 * exposes only live publication state through an anonymous security-definer
 * RPC keyed by the immutable Lix ID.
 */
async function resolvePublicLixWithSupabase(
	lixId: string,
	env: WorkerEnv,
	publicPath?: string,
): Promise<PublicLixResolution> {
	if (isDemoMode(env)) {
		const lix = demoLixSummaries(env).find(
			(candidate) => candidate.id === lixId,
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
		"/rest/v1/rpc/resolve_public_lix",
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
				p_lix_id: lixId,
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
	if (endpoint === "file" || endpoint === "admission")
		return request.method === "GET";
	if (isPublicSyncReadRequest(request, endpoint)) return true;
	return (
		request.method === "POST" &&
		["execute", "execute-batch", "observe", "observe/multiplex"].includes(
			endpoint,
		)
	);
}

type PublishedDirectoryEntry = {
	id: string;
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
SELECT id, path, 'file' AS kind
FROM lix_file
WHERE directory_id = (SELECT id FROM published_directory)
UNION ALL
SELECT id, path, 'directory' AS kind
FROM lix_directory
WHERE parent_id = (SELECT id FROM published_directory)
ORDER BY path
LIMIT 1001`,
			params: [{ kind: "text", value: directoryPath }],
		});
		const idColumn = result.columns.indexOf("id");
		const pathColumn = result.columns.indexOf("path");
		const kindColumn = result.columns.indexOf("kind");
		if (idColumn === -1 || pathColumn === -1 || kindColumn === -1) {
			throw new Error("Published directory query returned unexpected columns.");
		}
		const entries = result.rows.flatMap((row): PublishedDirectoryEntry[] => {
			const id = row[idColumn];
			const path = row[pathColumn];
			const kind = row[kindColumn];
			if (
				id?.kind !== "text" ||
				path?.kind !== "text" ||
				kind?.kind !== "text" ||
				(kind.value !== "file" && kind.value !== "directory")
			) {
				return [];
			}
			return [{ id: id.value, path: path.value, kind: kind.value }];
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
		(request.method === "GET" &&
			[
				"sync/pull",
				"sync/history",
				"sync/descriptor",
				"sync/blob",
				"sync/chunk",
			].includes(endpoint)) ||
		(request.method === "POST" &&
			[
				"sync/update",
				"sync/native-objects",
				"sync/native-object-range",
				"sync/native-metadata",
				"sync/baseline-lease/renew",
			].includes(endpoint))
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
		((endpoint === "file" || endpoint === "admission") &&
			request.method === "GET") ||
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
	const lixIds = new Set<string>();
	if (isDemoMode(env)) {
		lixIds.add(DEMO_LIX_ID);
		lixIds.add(DEMO_SECONDARY_LIX_ID);
	}
	for (const lixId of (
		env.LIXRAY_DEMO_LIX_IDS ??
		env.LIXRAY_DEMO_REPOSITORY_IDS ??
		""
	)
		.split(",")
		.map((lixId) => lixId.trim())
		.filter(Boolean)) {
		lixIds.add(lixId);
	}
	return lixIds;
}

function demoLixSummaries(env: WorkerEnv): Array<LixSummary> {
	return [...demoLixIds(env)].map((lixId, index) => ({
		id: lixId,
		name:
			lixId === DEMO_LIX_ID
				? DEMO_LIX_NAME
				: lixId === DEMO_SECONDARY_LIX_ID
					? DEMO_SECONDARY_LIX_NAME
					: `demo-lix-${index + 1}`,
		slug:
			lixId === DEMO_LIX_ID
				? DEMO_LIX_NAME
				: lixId === DEMO_SECONDARY_LIX_ID
					? DEMO_SECONDARY_LIX_NAME
					: `demo-lix-${index + 1}`,
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
		pathname === SIGNUP_TELEMETRY_PATH ||
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
				"Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-*, Traceparent, Tracestate, X-PostHog-AI-Trace-ID, X-PostHog-AI-Parent-ID, X-PostHog-AI-Session-ID",
			"access-control-max-age": "86400",
		},
	});
}

function remoteLixCorsPreflight(request: Request): Response {
	const origin = request.headers.get("origin") ?? "*";
	return new Response(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": origin,
			"access-control-allow-credentials": "true",
			"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
			"access-control-allow-headers":
				"Authorization, Content-Type, Content-Encoding, Content-Range, Idempotency-Key, Lix-Client-Id, Lix-Session-Id, Lix-Server-Protocol-Version, Lix-Sync-Protocol-Version, Lix-Transaction-Id, Lix-Upload-Id, Last-Event-ID, Range, X-Lixray-Public-Path, X-Lixray-Namespace-Id, X-Lixray-Repository-Name",
			"access-control-max-age": "86400",
			vary: "Origin",
		},
	});
}

function withRemoteLixCors(response: Response, request: Request): Response {
	const origin = request.headers.get("origin");
	if (!origin) return response;
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-credentials", "true");
	const exposedHeaders = headers.get("access-control-expose-headers");
	const exposedHeaderNames = new Set(
		exposedHeaders
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? [],
	);
	const normalizedExposedHeaderNames = new Set(
		[...exposedHeaderNames].map((value) => value.toLowerCase()),
	);
	for (const headerName of [
		"Accept-Ranges",
		"Content-Range",
		"Lix-File-Found",
		"Range",
	]) {
		if (!normalizedExposedHeaderNames.has(headerName.toLowerCase())) {
			exposedHeaderNames.add(headerName);
		}
	}
	headers.set(
		"access-control-expose-headers",
		[...exposedHeaderNames].join(", "),
	);
	const vary = headers.get("vary");
	if (
		!vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")
	) {
		headers.set("vary", vary ? `${vary}, Origin` : "Origin");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function profileCorsPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, HEAD, OPTIONS",
			"access-control-allow-headers": "If-None-Match",
			"access-control-max-age": "86400",
		},
	});
}

function resolvedProfileResponse(
	request: Request,
	namespaceId: string,
	profile: Extract<NamespaceProfileResolution, { ok: true }>,
): Response {
	const updatedAtToken = profile.updatedAt.replace(/[^0-9A-Za-z]/g, "");
	const etag = `W/"${namespaceId}-${updatedAtToken}"`;
	const headers = profileHeaders(etag, profile.updatedAt);
	const ifNoneMatch = request.headers.get("if-none-match");
	if (
		ifNoneMatch
			?.split(",")
			.map((candidate) => candidate.trim())
			.some((candidate) => candidate === "*" || candidate === etag)
	) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(
		request.method === "HEAD" ? null : JSON.stringify(profile.document),
		{ status: 200, headers },
	);
}

function profileActivityResponse(
	request: Request,
	activity: ReturnType<typeof aggregatePublicProfileActivity>,
): Response {
	return profileResponse(
		request.method === "HEAD" ? null : JSON.stringify(activity),
		{
			status: 200,
			headers: {
				"cache-control": `public, max-age=0, s-maxage=${PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS}`,
				"content-type": "application/json; charset=utf-8",
			},
		},
	);
}

function profileHeaders(etag: string, updatedAt: string): Headers {
	const headers = new Headers({
		"access-control-allow-origin": "*",
		"cache-control": "public, max-age=3600, stale-while-revalidate=86400",
		"content-type": "application/jscontact+json; version=2.0",
		etag,
		"x-content-type-options": "nosniff",
	});
	const updatedAtDate = new Date(updatedAt);
	if (!Number.isNaN(updatedAtDate.getTime())) {
		headers.set("last-modified", updatedAtDate.toUTCString());
	}
	return headers;
}

function profileResponse(body: BodyInit | null, init?: ResponseInit): Response {
	const response = new Response(body, init);
	return withProfileCors(response);
}

function withProfileCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", "*");
	headers.set("x-content-type-options", "nosniff");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
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

/** Fixed server-owned identity query; callers must authorize the resulting path. */
async function lookupLiveEntity(
	lixId: string,
	kind: EntityKind,
	selector: { id: string } | { path: string },
	env: WorkerEnv,
	options: HandleRequestOptions,
	signal: AbortSignal,
): Promise<{ id: string; path: string } | null> {
	if (!options.lixFetch) throw new Error("Internal Lix transport unavailable");
	const client = new WorkerLixRuntimeClient(
		env,
		{ userId: LIX_ANONYMOUS_ACCOUNT_ID, token: "" },
		() => Promise.resolve(null),
		{ lixFetch: options.lixFetch, fetcher: options.fetch, signal },
	);
	try {
		const result = await client.execute(lixId, {
			sql: `SELECT id, path FROM ${kind === "file" ? "lix_file" : "lix_directory"} WHERE ${"id" in selector ? "id" : "path"} = $1 LIMIT 1`,
			params: [
				{ kind: "text", value: "id" in selector ? selector.id : selector.path },
			],
		});
		const row = result.rows[0];
		const id = row?.[result.columns.indexOf("id")];
		const path = row?.[result.columns.indexOf("path")];
		return id?.kind === "text" && path?.kind === "text"
			? { id: id.value, path: path.value }
			: null;
	} finally {
		await client.close();
	}
}
