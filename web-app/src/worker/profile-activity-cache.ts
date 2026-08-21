import type { PublicProfileActivity } from "../lib/profile-activity-aggregate.ts";

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
		this.#freshForMs = options.freshForMs ?? 5 * 60 * 1000;
		this.#fallbackForMs = options.fallbackForMs ?? 24 * 60 * 60 * 1000;
		this.#now = options.now ?? Date.now;
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
