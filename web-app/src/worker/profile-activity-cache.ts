import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";

export const PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS = 24 * 60 * 60;
const PUBLIC_PROFILE_ACTIVITY_FALLBACK_MS = 48 * 60 * 60 * 1000;

interface CacheEntry {
	cachedAt: number;
	activity: PublicProfileActivity;
}

export class PublicProfileActivityCache {
	readonly #entries = new Map<string, CacheEntry>();
	readonly #refreshes = new Map<string, Promise<PublicProfileActivity>>();
	readonly #freshForMs: number;
	readonly #fallbackForMs: number;
	readonly #now: () => number;

	constructor(
		options: {
			freshForMs?: number;
			fallbackForMs?: number;
			now?: () => number;
		} = {},
	) {
		this.#freshForMs =
			options.freshForMs ?? PUBLIC_PROFILE_ACTIVITY_FRESH_SECONDS * 1000;
		this.#fallbackForMs =
			options.fallbackForMs ?? PUBLIC_PROFILE_ACTIVITY_FALLBACK_MS;
		this.#now = options.now ?? Date.now;
	}

	/** Drop the cached entry so the next request recomputes (e.g. after a visibility change). */
	invalidate(namespaceId: string): void {
		this.#entries.delete(namespaceId);
	}

	async resolve(
		namespaceId: string,
		load: () => Promise<PublicProfileActivity>,
	): Promise<PublicProfileActivity> {
		const now = this.#now();
		const cached = this.#entries.get(namespaceId);
		const age = cached ? now - cached.cachedAt : null;
		if (cached && age !== null && age >= 0 && age <= this.#freshForMs) {
			return cached.activity;
		}

		const running = this.#refreshes.get(namespaceId);
		if (running) return running;

		const refresh = (async () => {
			try {
				const activity = await load();
				this.#entries.set(namespaceId, { cachedAt: this.#now(), activity });
				return activity;
			} catch (error) {
				if (cached && age !== null && age >= 0 && age <= this.#fallbackForMs) {
					return cached.activity;
				}
				throw error;
			} finally {
				this.#refreshes.delete(namespaceId);
			}
		})();
		this.#refreshes.set(namespaceId, refresh);
		return refresh;
	}
}
