import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createRemoteJWKSet,
	errors,
	jwksCache,
	type JWTVerifyGetKey,
	type JWKSCacheInput,
} from "jose";

export type JwtVerifyFailureKind = "invalid_token" | "jwks_unavailable";

type CachedRemoteJwkSet = JWTVerifyGetKey & {
	reload: () => Promise<void>;
};

interface RemoteJwksEntry {
	getKey: CachedRemoteJwkSet;
	cache: JWKSCacheInput;
	cachePath?: string;
}

const verifiers = new Map<string, RemoteJwksEntry>();

function verifierKey(jwksUrl: string, cachePath?: string): string {
	return `${jwksUrl}\0${cachePath ?? ""}`;
}

export function resetRemoteJwksForTests(): void {
	verifiers.clear();
}

export async function loadPersistedJwksCache(
	cachePath: string,
): Promise<JWKSCacheInput> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as { uat?: unknown }).uat === "number" &&
			(parsed as { jwks?: unknown }).jwks &&
			typeof (parsed as { jwks?: unknown }).jwks === "object"
		) {
			return parsed as JWKSCacheInput;
		}
	} catch {
		// Missing or corrupt cache is a cold start.
	}
	return {};
}

export async function persistJwksCache(
	cachePath: string,
	cache: JWKSCacheInput,
): Promise<void> {
	if (!("uat" in cache) || typeof cache.uat !== "number") return;
	await mkdir(dirname(cachePath), { recursive: true });
	await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
}

export async function getRemoteJwks(
	jwksUrl: string,
	options: { cachePath?: string } = {},
): Promise<JWTVerifyGetKey> {
	const key = verifierKey(jwksUrl, options.cachePath);
	const existing = verifiers.get(key);
	if (existing) return existing.getKey;

	const cache = options.cachePath
		? await loadPersistedJwksCache(options.cachePath)
		: {};
	const getKey = createRemoteJWKSet(new URL(jwksUrl), {
		[jwksCache]: cache,
	}) as CachedRemoteJwkSet;
	verifiers.set(key, { getKey, cache, cachePath: options.cachePath });
	return getKey;
}

export async function persistRemoteJwksIfPresent(
	jwksUrl: string,
	cachePath?: string,
): Promise<void> {
	const entry = verifiers.get(verifierKey(jwksUrl, cachePath));
	if (!entry?.cachePath) return;
	await persistJwksCache(entry.cachePath, entry.cache);
}

export async function warmRemoteJwks(
	jwksUrl: string,
	options: { cachePath?: string } = {},
): Promise<void> {
	const getKey = (await getRemoteJwks(jwksUrl, options)) as CachedRemoteJwkSet;
	await getKey.reload();
	await persistRemoteJwksIfPresent(jwksUrl, options.cachePath);
}

export function classifyJwtVerifyError(error: unknown): JwtVerifyFailureKind {
	if (error instanceof errors.JWKSTimeout) return "jwks_unavailable";
	if (error instanceof errors.JWKSNoMatchingKey) return "invalid_token";
	if (error instanceof errors.JOSEError) {
		if (
			/JSON Web Key Set|Expected 200 OK|Failed to parse the JSON Web Key Set/.test(
				error.message,
			)
		) {
			return "jwks_unavailable";
		}
		return "invalid_token";
	}
	if (error instanceof TypeError && error.message === "fetch failed") {
		return "jwks_unavailable";
	}
	if (
		error instanceof Error &&
		/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|AbortError|TimeoutError/i.test(
			`${error.name} ${error.message}`,
		)
	) {
		return "jwks_unavailable";
	}
	return "invalid_token";
}
