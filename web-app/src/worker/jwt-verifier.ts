import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
	persistenceWarned?: boolean;
	persistedAt?: number;
	persistedJwks?: JWKSCacheInput["jwks"];
	persistence?: Promise<void>;
}

const verifiers = new Map<string, Promise<RemoteJwksEntry>>();
const UNKNOWN_KEY_REFRESH_INTERVAL_MS = 5_000;
const MAX_NEGATIVE_KEYS = 128;

class JwksRefreshThrottled extends Error {}

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
		const parsed: unknown = JSON.parse(await fs.readFile(cachePath, "utf8"));
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
	const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
	await fs.mkdir(dirname(cachePath), { recursive: true });
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await fs.rename(temporaryPath, cachePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

export async function getRemoteJwks(
	jwksUrl: string,
	options: { cachePath?: string } = {},
): Promise<JWTVerifyGetKey> {
	const key = verifierKey(jwksUrl, options.cachePath);
	let entry = verifiers.get(key);
	if (!entry) {
		entry = createVerifier(jwksUrl, options.cachePath);
		verifiers.set(key, entry);
	}
	return (await entry).getKey;
}

async function createVerifier(
	jwksUrl: string,
	cachePath?: string,
): Promise<RemoteJwksEntry> {
	const cache = cachePath ? await loadPersistedJwksCache(cachePath) : {};
	const remote = createRemoteJWKSet(new URL(jwksUrl), { [jwksCache]: cache });
	let lastUnknownRefresh = -Infinity;
	let refresh: Promise<void> | undefined;
	let negativeSnapshot = cache.jwks;
	const negativeKeys = new Set<string>();
	const getKey: CachedRemoteJwkSet = Object.assign(
		async (...args: Parameters<JWTVerifyGetKey>) => {
			try {
				return await remote(...args);
			} catch (error) {
				if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
				if (negativeSnapshot !== cache.jwks) {
					negativeKeys.clear();
					negativeSnapshot = cache.jwks;
				}
				// Bound both upstream work and memory for attacker-controlled key IDs.
				const id = JSON.stringify([args[0].alg, args[0].kid]);
				if (
					negativeKeys.has(id) &&
					Date.now() - lastUnknownRefresh < UNKNOWN_KEY_REFRESH_INTERVAL_MS
				)
					throw error;
				if (!refresh) {
					if (
						Date.now() - lastUnknownRefresh <
						UNKNOWN_KEY_REFRESH_INTERVAL_MS
					) {
						// An unseen key could have just rotated. Ask clients to retry,
						// rather than declaring their authorization invalid.
						throw new JwksRefreshThrottled();
					}
					lastUnknownRefresh = Date.now();
					refresh = remote.reload().finally(() => {
						refresh = undefined;
					});
				}
				await refresh;
				if (negativeSnapshot !== cache.jwks) {
					negativeKeys.clear();
					negativeSnapshot = cache.jwks;
				}
				try {
					return await remote(...args);
				} catch (retryError) {
					if (
						retryError instanceof errors.JWKSNoMatchingKey &&
						id.length <= 512 &&
						negativeKeys.size < MAX_NEGATIVE_KEYS
					) {
						negativeKeys.add(id);
					}
					throw retryError;
				}
			}
		},
		{ reload: () => remote.reload() },
	);
	return { getKey, cache, cachePath };
}

export async function persistRemoteJwksIfPresent(
	jwksUrl: string,
	cachePath?: string,
): Promise<void> {
	const entry = await verifiers.get(verifierKey(jwksUrl, cachePath));
	if (!entry?.cachePath) return;
	entry.persistence ??= persistLatestSnapshot(entry).finally(() => {
		entry.persistence = undefined;
	});
	await entry.persistence;
}

async function persistLatestSnapshot(entry: RemoteJwksEntry): Promise<void> {
	try {
		// Coalesce concurrent requests and serialize rotated snapshots. A newer
		// fetch during disk I/O must be flushed after the current atomic write.
		while (
			entry.persistedAt !== entry.cache.uat ||
			entry.persistedJwks !== entry.cache.jwks
		) {
			const snapshot = { ...entry.cache };
			await persistJwksCache(entry.cachePath!, snapshot);
			entry.persistedAt = snapshot.uat;
			entry.persistedJwks = snapshot.jwks;
		}
	} catch {
		// Disk is an optional restart optimization, never an authentication check.
		if (!entry.persistenceWarned) {
			entry.persistenceWarned = true;
			console.warn(
				"JWKS cache persistence failed; continuing with in-memory keys",
			);
		}
	}
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
	if (error instanceof JwksRefreshThrottled) return "jwks_unavailable";
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
