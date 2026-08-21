import type { PublicProfileActivity } from "~/lib/profile-activity-aggregate";

const CACHE_PREFIX = "lixray.public-profile-activity.v1:";
const FRESH_FOR_MS = 5 * 60 * 1000;
const FALLBACK_FOR_MS = 24 * 60 * 60 * 1000;

interface ProfileActivityCacheEntry {
	cachedAt: number;
	activity: PublicProfileActivity;
}

interface ProfileActivityStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export async function resolvePublicProfileActivity(
	input: { namespaceId: string },
	options: {
		fetcher?: typeof fetch;
		storage?: ProfileActivityStorage | null;
		now?: () => number;
	} = {},
): Promise<PublicProfileActivity> {
	const fetcher = options.fetcher ?? globalThis.fetch;
	const storage =
		options.storage === undefined ? browserStorage() : options.storage;
	const now = options.now?.() ?? Date.now();
	const cacheKey = `${CACHE_PREFIX}${input.namespaceId}`;
	const cached = readCachedActivity(storage, cacheKey);
	const cacheAge = cached ? now - cached.cachedAt : null;

	if (
		cached &&
		cacheAge !== null &&
		cacheAge >= 0 &&
		cacheAge <= FRESH_FOR_MS
	) {
		return cached.activity;
	}

	try {
		const response = await fetcher(
			`/profile/${encodeURIComponent(input.namespaceId)}/activity`,
			{ headers: { Accept: "application/json" } },
		);
		if (!response.ok) {
			throw new Error("Unable to load public repositories.");
		}

		const activity: unknown = await response.json();
		if (!isPublicProfileActivity(activity)) {
			throw new Error("The public repository response is invalid.");
		}

		writeCachedActivity(storage, cacheKey, { cachedAt: now, activity });
		return activity;
	} catch (error) {
		if (
			cached &&
			cacheAge !== null &&
			cacheAge >= 0 &&
			cacheAge <= FALLBACK_FOR_MS
		) {
			return cached.activity;
		}
		throw error;
	}
}

function browserStorage(): ProfileActivityStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function readCachedActivity(
	storage: ProfileActivityStorage | null,
	key: string,
): ProfileActivityCacheEntry | null {
	if (!storage) return null;
	try {
		const value = storage.getItem(key);
		if (!value) return null;
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		if (
			typeof parsed.cachedAt !== "number" ||
			!Number.isFinite(parsed.cachedAt)
		) {
			return null;
		}
		if (!isPublicProfileActivity(parsed.activity)) return null;
		return { cachedAt: parsed.cachedAt, activity: parsed.activity };
	} catch {
		return null;
	}
}

function writeCachedActivity(
	storage: ProfileActivityStorage | null,
	key: string,
	entry: ProfileActivityCacheEntry,
): void {
	if (!storage) return;
	try {
		storage.setItem(key, JSON.stringify(entry));
	} catch {
		// A denied or full browser cache should not block the profile.
	}
}

function isPublicProfileActivity(
	value: unknown,
): value is PublicProfileActivity {
	if (!isRecord(value)) return false;
	if (!isNonNegativeNumber(value.totalFiles)) return false;
	if (!isNonNegativeNumber(value.failedRepositories)) return false;
	if (!Array.isArray(value.repositories) || !Array.isArray(value.fileMix)) {
		return false;
	}

	return (
		value.repositories.every(
			(repository) =>
				isRecord(repository) &&
				typeof repository.id === "string" &&
				typeof repository.name === "string" &&
				typeof repository.slug === "string" &&
				typeof repository.namespaceHandle === "string" &&
				(repository.fileCount === null ||
					isNonNegativeNumber(repository.fileCount)),
		) &&
		value.fileMix.every(
			(segment) =>
				isRecord(segment) &&
				typeof segment.label === "string" &&
				typeof segment.examples === "string" &&
				typeof segment.color === "string" &&
				isNonNegativeNumber(segment.count) &&
				isNonNegativeNumber(segment.percentage),
		)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
