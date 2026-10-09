export function createTrackedOfflineContexts<T extends object>() {
	const offlineContexts = new WeakSet<T>();
	return {
		has(context: T) {
			return offlineContexts.has(context);
		},
		async setOffline(
			context: T,
			offline: boolean,
			apply: (offline: boolean) => Promise<unknown>,
		) {
			if (offline) offlineContexts.add(context);
			await apply(offline);
			if (!offline) offlineContexts.delete(context);
		},
	};
}
