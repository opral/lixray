import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";

export const PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS = 24 * 60 * 60;
const PUBLIC_PROFILE_ACTIVITY_FALLBACK_MS = 48 * 60 * 60 * 1000;
const CACHE_EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;
export const PUBLIC_PROFILE_ACTIVITY_MAX_CACHE_ENTRIES = 256;

interface CacheEntry {
	cachedAt: number;
	activity: PublicProfileActivity;
}

export class PublicProfileActivityCache {
	readonly #entries = new Map<string, CacheEntry>();
	readonly #refreshes = new Map<
		string,
		{ promise: Promise<PublicProfileActivity> | null }
	>();
	readonly #freshForMs: number;
	readonly #fallbackForMs: number;
	readonly #maxEntries: number;
	readonly #now: () => number;
	#lastPrunedAt = Number.NEGATIVE_INFINITY;

	constructor(
		options: {
			freshForMs?: number;
			fallbackForMs?: number;
			maxEntries?: number;
			now?: () => number;
		} = {},
	) {
		this.#freshForMs =
			options.freshForMs ?? PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS * 1000;
		this.#fallbackForMs =
			options.fallbackForMs ?? PUBLIC_PROFILE_ACTIVITY_FALLBACK_MS;
		this.#maxEntries =
			options.maxEntries ?? PUBLIC_PROFILE_ACTIVITY_MAX_CACHE_ENTRIES;
		if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
			throw new RangeError("maxEntries must be a positive safe integer");
		}
		this.#now = options.now ?? Date.now;
	}

	/** Drop cached and in-flight results so a later request observes the change. */
	invalidate(namespaceId: string): void {
		this.#entries.delete(namespaceId);
		this.#refreshes.delete(namespaceId);
	}

	/** Current retained result count, exposed for boundedness checks and metrics. */
	get size(): number {
		return this.#entries.size;
	}

	async resolve(
		namespaceId: string,
		load: () => Promise<PublicProfileActivity>,
	): Promise<PublicProfileActivity> {
		const now = this.#now();
		this.#prune(now);
		const cached = this.#entries.get(namespaceId);
		const age = cached ? now - cached.cachedAt : null;
		if (cached && (age === null || age < 0 || age > this.#fallbackForMs)) {
			this.#entries.delete(namespaceId);
		}
		if (cached && age !== null && age >= 0 && age <= this.#freshForMs) {
			this.#entries.delete(namespaceId);
			this.#entries.set(namespaceId, cached);
			return cached.activity;
		}

		const running = this.#refreshes.get(namespaceId);
		if (running) return running.promise!;

		const refreshState: { promise: Promise<PublicProfileActivity> | null } = {
			promise: null,
		};
		const refresh = (async () => {
			try {
				// Defer invocation until after the in-flight state is installed so a
				// synchronously throwing loader cannot strand a rejected refresh.
				const activity = await Promise.resolve().then(load);
				// Invalidation removes this exact refresh state. An older scan may
				// still satisfy its original callers, but cannot repopulate the cache.
				if (this.#refreshes.get(namespaceId) === refreshState) {
					this.#entries.delete(namespaceId);
					this.#entries.set(namespaceId, { cachedAt: this.#now(), activity });
					this.#evictOverCapacity();
				}
				return activity;
			} catch (error) {
				if (cached && age !== null && age >= 0 && age <= this.#fallbackForMs) {
					return cached.activity;
				}
				throw error;
			} finally {
				if (this.#refreshes.get(namespaceId) === refreshState) {
					this.#refreshes.delete(namespaceId);
				}
			}
		})();
		refreshState.promise = refresh;
		this.#refreshes.set(namespaceId, refreshState);
		return refresh;
	}

	#prune(now: number): void {
		if (now - this.#lastPrunedAt < CACHE_EXPIRY_SWEEP_INTERVAL_MS) return;
		this.#lastPrunedAt = now;
		for (const [namespaceId, entry] of this.#entries) {
			const age = now - entry.cachedAt;
			if (age < 0 || age > this.#fallbackForMs) {
				this.#entries.delete(namespaceId);
			}
		}
		this.#evictOverCapacity();
	}

	#evictOverCapacity(): void {
		while (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}
}
