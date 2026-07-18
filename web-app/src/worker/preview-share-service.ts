import { DEMO_AUTH_TOKEN } from "../lib/demo-identity.ts";
import type {
	AuthenticatedUser,
	AuthResult,
	McpAuthResult,
} from "./handler.ts";

/**
 * Preview-only capability and test-session storage.
 *
 * The real sharing flow uses Supabase functions. PR previews deliberately have
 * no Supabase binding, so this service gives the preview an isolated opaque
 * token store and a server-verifiable test-account session. The session keeps
 * the preview honest: canonical URLs remain public read-only, while writes and
 * share creation require an explicit preview sign-in plus workspace membership.
 */

const PREVIEW_SHARE_PREFIX = "lixray-preview/v1";
const PREVIEW_SHARE_ENDPOINT = "/_preview/workspace-share-capabilities";
const PREVIEW_SESSION_ENDPOINT = "/_preview/demo-session";
const PREVIEW_SESSION_COOKIE = "lixray_preview_session";
const TOKEN_BYTES = 32;
const MAX_MINT_ATTEMPTS = 4;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const PREVIEW_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

export type PreviewSessionMode = "owner" | "recipient";

export interface PreviewDemoSession {
	readonly workspaceIds: ReadonlyArray<string>;
}

export interface PreviewShareToken {
	readonly token: string;
	readonly workspaceId: string;
	readonly sharedByName: string | null;
	readonly grantsEdit: true;
}

export interface CreatePreviewShareServiceOptions {
	/** The dedicated R2 binding used by preview Workers. */
	readonly previewState: R2Bucket;
	/** `new URL(request.url).hostname`; this scopes preview versions from each other. */
	readonly hostname: string;
	/** The current preview's configured demo workspaces. */
	readonly allowedWorkspaceIds: Iterable<string>;
	/** Test seam; production callers should omit this and use Web Crypto. */
	readonly tokenGenerator?: () => string;
}

export interface MintPreviewShareTokenInput {
	readonly workspaceId: string;
	readonly sharedByName: string | null;
}

export interface PreviewShareService {
	mint(input: MintPreviewShareTokenInput): Promise<PreviewShareToken>;
	resolve(token: string): Promise<PreviewShareToken | null>;
	/**
	 * Validates an invite for the current hostname. The demo caller can then
	 * record its own browser-session membership; no unauthenticated server-side
	 * membership record is created here.
	 */
	accept(token: string): Promise<PreviewShareToken | null>;
}

export interface PreviewShareRequestEnv {
	readonly LIXRAY_DEMO?: string;
	readonly LIXRAY_DEMO_WORKSPACE_IDS?: string;
	readonly PREVIEW_STATE: R2Bucket;
}

export class PreviewShareServiceError extends Error {
	readonly code:
		| "PREVIEW_SHARE_HOSTNAME_INVALID"
		| "PREVIEW_SHARE_WORKSPACE_NOT_ALLOWED"
		| "PREVIEW_SHARE_TOKEN_GENERATION_FAILED";

	constructor(
		code:
			| "PREVIEW_SHARE_HOSTNAME_INVALID"
			| "PREVIEW_SHARE_WORKSPACE_NOT_ALLOWED"
			| "PREVIEW_SHARE_TOKEN_GENERATION_FAILED",
		message: string,
	) {
		super(message);
		this.name = "PreviewShareServiceError";
		this.code = code;
	}
}

interface StoredPreviewShareToken {
	readonly version: 1;
	readonly workspaceId: string;
	readonly sharedByName: string | null;
	readonly grantsEdit: true;
}

interface StoredPreviewSession {
	readonly version: 1;
	readonly workspaceIds: ReadonlyArray<string>;
}

interface PreviewSessionRecord extends PreviewDemoSession {
	readonly token: string;
	readonly hostname: string;
}

/**
 * Creates an R2-backed, hostname-scoped capability store for the demo preview.
 * Keep this service out of the normal Worker: it has no user identity and is
 * intentionally useful only for the isolated preview runtime.
 */
export function createPreviewShareService(
	options: CreatePreviewShareServiceOptions,
): PreviewShareService {
	const hostname = normalizeHostname(options.hostname);
	const allowedWorkspaceIds = new Set(
		[...options.allowedWorkspaceIds]
			.map((workspaceId) => workspaceId.trim())
			.filter(Boolean),
	);
	const tokenGenerator = options.tokenGenerator ?? createOpaqueToken;

	const resolve = async (token: string): Promise<PreviewShareToken | null> => {
		if (!isPreviewShareToken(token)) return null;
		const object = await options.previewState.get(
			previewShareTokenKey(hostname, token),
		);
		if (!object) return null;

		const stored = await readStoredToken(object);
		if (
			!stored ||
			!allowedWorkspaceIds.has(stored.workspaceId) ||
			stored.grantsEdit !== true
		) {
			return null;
		}
		return {
			token,
			workspaceId: stored.workspaceId,
			sharedByName: stored.sharedByName,
			grantsEdit: true,
		};
	};

	return {
		async mint({ workspaceId, sharedByName }) {
			if (!allowedWorkspaceIds.has(workspaceId)) {
				throw new PreviewShareServiceError(
					"PREVIEW_SHARE_WORKSPACE_NOT_ALLOWED",
					"This workspace is not available in the preview.",
				);
			}
			if (sharedByName !== null && typeof sharedByName !== "string") {
				throw new TypeError("sharedByName must be a string or null");
			}

			const stored: StoredPreviewShareToken = {
				version: 1,
				workspaceId,
				sharedByName,
				grantsEdit: true,
			};
			for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
				const token = tokenGenerator();
				if (!isPreviewShareToken(token)) {
					throw new PreviewShareServiceError(
						"PREVIEW_SHARE_TOKEN_GENERATION_FAILED",
						"The preview share-token generator returned an invalid token.",
					);
				}
				const written = await options.previewState.put(
					previewShareTokenKey(hostname, token),
					JSON.stringify(stored),
					{
						httpMetadata: { contentType: "application/json; charset=utf-8" },
						onlyIf: { etagDoesNotMatch: "*" },
					},
				);
				if (written) {
					return { token, workspaceId, sharedByName, grantsEdit: true };
				}
			}

			throw new PreviewShareServiceError(
				"PREVIEW_SHARE_TOKEN_GENERATION_FAILED",
				"Unable to mint a unique preview share link. Try again.",
			);
		},
		resolve,
		accept: resolve,
	};
}

/**
 * Browser-facing adapter for the preview-only capability simulator. It is
 * intentionally available only from a demo preview Worker and always returns
 * no-store JSON. Production never imports or routes this handler.
 */
export async function handlePreviewShareRequest(
	request: Request,
	env: PreviewShareRequestEnv,
): Promise<Response | null> {
	if (env.LIXRAY_DEMO !== "1") return null;
	const url = new URL(request.url);
	if (
		url.pathname !== PREVIEW_SESSION_ENDPOINT &&
		url.pathname !== PREVIEW_SHARE_ENDPOINT &&
		!url.pathname.startsWith(`${PREVIEW_SHARE_ENDPOINT}/`)
	) {
		return null;
	}

	const hostname = normalizeHostname(url.hostname);
	const allowedWorkspaceIds = previewAllowedWorkspaceIds(
		env.LIXRAY_DEMO_WORKSPACE_IDS,
	);
	if (url.pathname === PREVIEW_SESSION_ENDPOINT) {
		try {
			return await handlePreviewSessionRequest(
				request,
				env.PREVIEW_STATE,
				hostname,
				allowedWorkspaceIds,
			);
		} catch (caught) {
			return previewJson(
				{
					error:
						caught instanceof Error
							? caught.message
							: "Unable to complete the preview sign-in request.",
				},
				500,
			);
		}
	}

	const service = createPreviewShareService({
		previewState: env.PREVIEW_STATE,
		hostname,
		allowedWorkspaceIds,
	});
	const suffix = url.pathname.slice(PREVIEW_SHARE_ENDPOINT.length);

	try {
		if (suffix === "") {
			if (request.method !== "POST") return methodNotAllowed();
			const session = await previewSessionFromRequest(
				request,
				env.PREVIEW_STATE,
				hostname,
				allowedWorkspaceIds,
			);
			if (!session) return previewUnauthorized();
			const workspaceId = await requestedWorkspaceId(request);
			if (!session.workspaceIds.includes(workspaceId)) {
				return previewJson(
					{ error: "Join this workspace before creating a share link." },
					403,
				);
			}
			const share = await service.mint({
				workspaceId,
				sharedByName: "Preview test account",
			});
			return previewJson({ token: share.token });
		}

		const resolveMatch = /^\/([A-Za-z0-9_-]{32,256})$/.exec(suffix);
		if (resolveMatch) {
			if (request.method !== "GET") return methodNotAllowed();
			return shareResponse(await service.resolve(resolveMatch[1]));
		}

		const acceptMatch = /^\/([A-Za-z0-9_-]{32,256})\/accept$/.exec(suffix);
		if (acceptMatch) {
			if (request.method !== "POST") return methodNotAllowed();
			const session = await previewSessionFromRequest(
				request,
				env.PREVIEW_STATE,
				hostname,
				allowedWorkspaceIds,
			);
			if (!session) return previewUnauthorized();
			const share = await service.accept(acceptMatch[1]);
			if (!share) return shareResponse(null);
			const updatedSession = await addWorkspaceToPreviewSession(
				env.PREVIEW_STATE,
				session,
				share.workspaceId,
				allowedWorkspaceIds,
			);
			if (!updatedSession) return previewUnauthorized();
			return shareResponse(share);
		}

		return previewJson({ error: "Share link not found." }, 404);
	} catch (caught) {
		return previewJson(
			{
				error:
					caught instanceof Error
						? caught.message
						: "Unable to complete the preview share request.",
			},
			caught instanceof PreviewShareServiceError ? 400 : 500,
		);
	}
}

/**
 * Validates the browser's test-account cookie and the demo bearer used by the
 * in-browser Lix transport. The bearer alone is deliberately insufficient.
 */
export async function authenticatePreviewDemoBrowser(
	request: Request,
	env: PreviewShareRequestEnv,
): Promise<AuthResult> {
	if (request.headers.get("Authorization") !== `Bearer ${DEMO_AUTH_TOKEN}`) {
		return previewAuthFailure();
	}
	return authenticatePreviewSession(request, env);
}

/**
 * MCP in a preview is also bound to the server-side test session. Unlike the
 * browser transport, it has no need to expose the demo bearer to callers.
 */
export async function authenticatePreviewDemoMcp(
	request: Request,
	env: PreviewShareRequestEnv,
): Promise<McpAuthResult> {
	const result = await authenticatePreviewSession(request, env);
	if (!result.ok) return result;
	return {
		ok: true,
		auth: {
			...result.auth,
			clientId: "lixray-preview-test-account",
		},
	};
}

/**
 * Confirms an authenticated preview test account joined this exact workspace.
 * Public reads remain handled by the normal demo public-read authorizer.
 */
export function authorizePreviewDemoWorkspace(
	workspaceId: string,
	auth: AuthenticatedUser,
	env: PreviewShareRequestEnv,
): Promise<Response | null> {
	if (env.LIXRAY_DEMO !== "1") return Promise.resolve(previewAuthResponse());
	if (
		!previewAllowedWorkspaceIds(env.LIXRAY_DEMO_WORKSPACE_IDS).has(workspaceId)
	) {
		return Promise.resolve(
			new Response("Workspace access denied\n", { status: 403 }),
		);
	}
	if (auth.token !== DEMO_AUTH_TOKEN)
		return Promise.resolve(previewAuthResponse());
	return Promise.resolve(
		auth.previewWorkspaceIds?.includes(workspaceId)
			? null
			: new Response("Workspace access denied\n", { status: 403 }),
	);
}

/** Parse the preview Worker variable without importing its broader environment. */
export function previewAllowedWorkspaceIds(
	value: string | undefined,
): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((workspaceId) => workspaceId.trim())
			.filter(Boolean),
	);
}

export function isPreviewShareToken(value: unknown): value is string {
	return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

async function handlePreviewSessionRequest(
	request: Request,
	previewState: R2Bucket,
	hostname: string,
	allowedWorkspaceIds: ReadonlySet<string>,
): Promise<Response> {
	if (request.method === "GET") {
		const session = await previewSessionFromRequest(
			request,
			previewState,
			hostname,
			allowedWorkspaceIds,
		);
		return previewJson(previewSessionPayload(session));
	}

	if (request.method === "POST") {
		const mode = await requestedPreviewSessionMode(request);
		const session = await createPreviewSession(
			previewState,
			hostname,
			allowedWorkspaceIds,
			mode,
		);
		return previewJson(previewSessionPayload(session), 200, {
			"Set-Cookie": previewSessionCookie(session.token, request),
		});
	}

	if (request.method === "DELETE") {
		const session = await previewSessionFromRequest(
			request,
			previewState,
			hostname,
			allowedWorkspaceIds,
		);
		if (session) {
			await previewState.delete(
				previewSessionKey(session.hostname, session.token),
			);
		}
		return new Response(null, {
			status: 204,
			headers: {
				"Cache-Control": "no-store",
				"Set-Cookie": clearPreviewSessionCookie(request),
			},
		});
	}

	return methodNotAllowed("GET, POST, DELETE");
}

function previewSessionPayload(session: PreviewSessionRecord | null): {
	signedIn: boolean;
	workspaceIds: ReadonlyArray<string>;
} {
	return {
		signedIn: session !== null,
		workspaceIds: session?.workspaceIds ?? [],
	};
}

async function requestedPreviewSessionMode(
	request: Request,
): Promise<PreviewSessionMode> {
	try {
		const value: unknown = await request.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new TypeError("mode is required");
		}
		const mode = "mode" in value ? value.mode : null;
		if (mode === "owner" || mode === "recipient") return mode;
		throw new TypeError("mode must be owner or recipient");
	} catch (caught) {
		if (caught instanceof TypeError) throw caught;
		throw new TypeError("The preview sign-in request must contain JSON.", {
			cause: caught,
		});
	}
}

async function createPreviewSession(
	previewState: R2Bucket,
	hostname: string,
	allowedWorkspaceIds: ReadonlySet<string>,
	mode: PreviewSessionMode,
): Promise<PreviewSessionRecord> {
	const workspaceIds = mode === "owner" ? [...allowedWorkspaceIds] : [];
	const stored: StoredPreviewSession = { version: 1, workspaceIds };
	for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
		const token = createOpaqueToken();
		const written = await previewState.put(
			previewSessionKey(hostname, token),
			JSON.stringify(stored),
			{
				httpMetadata: { contentType: "application/json; charset=utf-8" },
				onlyIf: { etagDoesNotMatch: "*" },
			},
		);
		if (written) return { hostname, token, workspaceIds };
	}
	throw new PreviewShareServiceError(
		"PREVIEW_SHARE_TOKEN_GENERATION_FAILED",
		"Unable to create a preview test session. Try again.",
	);
}

async function previewSessionFromRequest(
	request: Request,
	previewState: R2Bucket,
	hostname: string,
	allowedWorkspaceIds: ReadonlySet<string>,
): Promise<PreviewSessionRecord | null> {
	const token = previewSessionTokenFromCookie(request.headers.get("Cookie"));
	if (!token) return null;
	return previewSessionByToken(
		previewState,
		hostname,
		token,
		allowedWorkspaceIds,
	);
}

async function previewSessionByToken(
	previewState: R2Bucket,
	hostname: string,
	token: string,
	allowedWorkspaceIds: ReadonlySet<string>,
): Promise<PreviewSessionRecord | null> {
	if (!isPreviewShareToken(token)) return null;
	const object = await previewState.get(previewSessionKey(hostname, token));
	if (!object) return null;
	const stored = await readStoredSession(object, allowedWorkspaceIds);
	if (!stored) return null;
	return { hostname, token, workspaceIds: stored.workspaceIds };
}

async function addWorkspaceToPreviewSession(
	previewState: R2Bucket,
	session: PreviewSessionRecord,
	workspaceId: string,
	allowedWorkspaceIds: ReadonlySet<string>,
): Promise<PreviewSessionRecord | null> {
	if (!allowedWorkspaceIds.has(workspaceId)) return null;
	const key = previewSessionKey(session.hostname, session.token);
	for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
		const object = await previewState.get(key);
		if (!object) return null;
		const stored = await readStoredSession(object, allowedWorkspaceIds);
		if (!stored) return null;
		if (stored.workspaceIds.includes(workspaceId)) {
			return {
				hostname: session.hostname,
				token: session.token,
				workspaceIds: stored.workspaceIds,
			};
		}
		const workspaceIds = [...stored.workspaceIds, workspaceId];
		const written = await previewState.put(
			key,
			JSON.stringify({
				version: 1,
				workspaceIds,
			} satisfies StoredPreviewSession),
			{
				httpMetadata: { contentType: "application/json; charset=utf-8" },
				onlyIf: { etagMatches: object.etag },
			},
		);
		if (written) {
			return { hostname: session.hostname, token: session.token, workspaceIds };
		}
	}
	return null;
}

async function authenticatePreviewSession(
	request: Request,
	env: PreviewShareRequestEnv,
): Promise<AuthResult> {
	if (env.LIXRAY_DEMO !== "1") return previewAuthFailure();
	try {
		const hostname = normalizeHostname(new URL(request.url).hostname);
		const session = await previewSessionFromRequest(
			request,
			env.PREVIEW_STATE,
			hostname,
			previewAllowedWorkspaceIds(env.LIXRAY_DEMO_WORKSPACE_IDS),
		);
		if (!session) return previewAuthFailure();
		return {
			ok: true,
			auth: {
				// Keep the agent-review session aligned with the browser's preview
				// test account. Authorization remains per-request: this membership
				// snapshot was just read from the HttpOnly server-side session.
				userId: DEMO_AUTH_TOKEN,
				token: DEMO_AUTH_TOKEN,
				isDemo: true,
				previewWorkspaceIds: session.workspaceIds,
			},
		};
	} catch {
		return {
			ok: false,
			response: new Response("Preview session storage is unavailable\n", {
				status: 503,
			}),
		};
	}
}

function previewAuthFailure(): AuthResult {
	return {
		ok: false,
		response: previewAuthResponse(),
	};
}

function previewAuthResponse(): Response {
	return new Response("Sign in to access this workspace.\n", {
		status: 401,
		headers: { "WWW-Authenticate": "Bearer" },
	});
}

function previewUnauthorized(): Response {
	return previewJson({ error: "Sign in to continue." }, 401, {
		"WWW-Authenticate": "Bearer",
	});
}

function previewSessionTokenFromCookie(
	cookieHeader: string | null,
): string | null {
	if (!cookieHeader) return null;
	for (const entry of cookieHeader.split(";")) {
		const [name, ...valueParts] = entry.trim().split("=");
		if (name !== PREVIEW_SESSION_COOKIE || valueParts.length === 0) continue;
		const value = valueParts.join("=");
		return isPreviewShareToken(value) ? value : null;
	}
	return null;
}

function previewSessionCookie(token: string, request: Request): string {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${PREVIEW_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_SESSION_MAX_AGE_SECONDS}${secure}`;
}

function clearPreviewSessionCookie(request: Request): string {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${PREVIEW_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function requestedWorkspaceId(request: Request): Promise<string> {
	try {
		const value: unknown = await request.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new TypeError("workspaceId is required");
		}
		const workspaceId = "workspaceId" in value ? value.workspaceId : null;
		if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
			throw new TypeError("workspaceId is required");
		}
		return workspaceId;
	} catch (caught) {
		if (caught instanceof TypeError) throw caught;
		throw new TypeError("The preview share request must contain JSON.", {
			cause: caught,
		});
	}
}

function shareResponse(share: PreviewShareToken | null): Response {
	if (!share) return previewJson({ error: "Share link not found." }, 404);
	return previewJson({
		workspaceId: share.workspaceId,
		sharedByName: share.sharedByName,
		grantsEdit: true,
	});
}

function methodNotAllowed(allow = "GET, POST"): Response {
	return previewJson({ error: "Method not allowed." }, 405, {
		Allow: allow,
	});
}

function previewJson(
	value: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store", ...headers },
	});
}

export function previewShareTokenKey(hostname: string, token: string): string {
	const normalizedHostname = normalizeHostname(hostname);
	if (!isPreviewShareToken(token)) {
		throw new TypeError("A valid preview share token is required");
	}
	return `${PREVIEW_SHARE_PREFIX}/${encodeURIComponent(normalizedHostname)}/shares/${token}.json`;
}

export function previewSessionKey(hostname: string, token: string): string {
	const normalizedHostname = normalizeHostname(hostname);
	if (!isPreviewShareToken(token)) {
		throw new TypeError("A valid preview session token is required");
	}
	return `${PREVIEW_SHARE_PREFIX}/${encodeURIComponent(normalizedHostname)}/sessions/${token}.json`;
}

function normalizeHostname(value: string): string {
	const hostname = value.trim().toLowerCase();
	if (!hostname || hasInvalidHostnameCharacter(hostname)) {
		throw new PreviewShareServiceError(
			"PREVIEW_SHARE_HOSTNAME_INVALID",
			"A valid preview hostname is required.",
		);
	}
	return hostname;
}

function hasInvalidHostnameCharacter(hostname: string): boolean {
	for (const character of hostname) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x1f ||
			/\s/u.test(character) ||
			character === "/" ||
			character === "\\"
		) {
			return true;
		}
	}
	return false;
}

function createOpaqueToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function readStoredToken(
	object: R2ObjectBody,
): Promise<StoredPreviewShareToken | null> {
	try {
		const text = new TextDecoder().decode(await object.arrayBuffer());
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const record = value as Partial<StoredPreviewShareToken>;
		if (
			record.version !== 1 ||
			typeof record.workspaceId !== "string" ||
			record.workspaceId.length === 0 ||
			(record.sharedByName !== null &&
				typeof record.sharedByName !== "string") ||
			record.grantsEdit !== true
		) {
			return null;
		}
		return {
			version: 1,
			workspaceId: record.workspaceId,
			sharedByName: record.sharedByName ?? null,
			grantsEdit: true,
		};
	} catch {
		return null;
	}
}

async function readStoredSession(
	object: R2ObjectBody,
	allowedWorkspaceIds: ReadonlySet<string>,
): Promise<StoredPreviewSession | null> {
	try {
		const text = new TextDecoder().decode(await object.arrayBuffer());
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		const record = value as Partial<StoredPreviewSession>;
		if (
			record.version !== 1 ||
			!Array.isArray(record.workspaceIds) ||
			record.workspaceIds.some(
				(workspaceId) =>
					typeof workspaceId !== "string" ||
					workspaceId.length === 0 ||
					!allowedWorkspaceIds.has(workspaceId),
			)
		) {
			return null;
		}
		return { version: 1, workspaceIds: [...new Set(record.workspaceIds)] };
	} catch {
		return null;
	}
}
