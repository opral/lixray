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
	return readReplicaRoute(sourceName, storage)?.activeName ?? sourceName;
}

/** Names of OPFS databases retained by the former app-managed migration. */
export function retainedReplicaStorageNames(
	sourceName: string,
	storage: Pick<Storage, "getItem"> = globalThis.localStorage,
): string[] {
	return [...(readReplicaRoute(sourceName, storage)?.retainedSources ?? [])];
}

function readReplicaRoute(
	sourceName: string,
	storage: Pick<Storage, "getItem">,
): ReplicaRoute | null {
	const key = `lixray:replica-route:81:${encodeURIComponent(sourceName)}`;
	const stored = storage.getItem(key);
	// Normal opening now owns upgrades. Keep previously published destinations
	// authoritative, and leave retained sources and interrupted copies untouched.
	if (stored === null) return null;
	const route: unknown = JSON.parse(stored);
	if (!isReplicaRoute(route, sourceName))
		throw new Error(
			"Stored replica routing metadata is invalid; retained data must be recovered.",
		);
	return route;
}
function isReplicaRoute(
	value: unknown,
	sourceName: string,
): value is ReplicaRoute {
	if (!value || typeof value !== "object") return false;
	const route = value as Partial<ReplicaRoute>;
	if (!Array.isArray(route.retainedSources)) return false;
	const formatPrefix = `${sourceName}:format81:`;
	const retained = route.retainedSources;
	return (
		route.version === 1 &&
		route.sourceName === sourceName &&
		typeof route.activeName === "string" &&
		route.activeName.startsWith(formatPrefix) &&
		route.activeName.length > formatPrefix.length &&
		typeof route.sourceDigest === "string" &&
		/^[a-f0-9]{64}$/.test(route.sourceDigest) &&
		route.retainedSources.every(
			(name) =>
				typeof name === "string" &&
				(name === sourceName ||
					(name.startsWith(formatPrefix) && name.length > formatPrefix.length)),
		) &&
		new Set(retained).size === retained.length &&
		!retained.includes(route.activeName)
	);
}
