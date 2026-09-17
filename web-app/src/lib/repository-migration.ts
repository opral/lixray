/** Resolve storage names published by the former app-managed migration. */
export interface ReplicaRoute {
	version: 1;
	activeName: string;
	sourceName: string;
	sourceDigest: string;
	retainedSources: string[];
}

export function currentReplicaStorage(
	sourceName: string,
	storage: Pick<Storage, "getItem"> = globalThis.localStorage,
): string {
	const key = `lixray:replica-route:81:${encodeURIComponent(sourceName)}`;
	const stored = storage.getItem(key);
	// Normal opening now owns upgrades. Keep previously published destinations
	// authoritative, and leave retained sources and interrupted copies untouched.
	if (stored === null) return sourceName;
	const route: unknown = JSON.parse(stored);
	if (!isReplicaRoute(route, sourceName))
		throw new Error(
			"Stored replica routing metadata is invalid; retained data must be recovered.",
		);
	return route.activeName;
}
function isReplicaRoute(
	value: unknown,
	sourceName: string,
): value is ReplicaRoute {
	if (!value || typeof value !== "object") return false;
	const route = value as Partial<ReplicaRoute>;
	return (
		route.version === 1 &&
		route.sourceName === sourceName &&
		typeof route.activeName === "string" &&
		route.activeName.startsWith(`${sourceName}:format81:`) &&
		typeof route.sourceDigest === "string" &&
		/^[a-f0-9]{64}$/.test(route.sourceDigest) &&
		Array.isArray(route.retainedSources) &&
		route.retainedSources.every((name) => typeof name === "string")
	);
}
