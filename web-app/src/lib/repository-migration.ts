/** The only legacy-format router. The normal SDK never imports migration code. */
export interface ReplicaRoute {
	version: 1;
	activeName: string;
	sourceName: string;
	sourceDigest: string;
	retainedSources: string[];
}
interface MigrationResult {
	destinationName: string;
	sourceDigest: string;
	empty?: boolean;
}
interface MigrationOptions {
	sourceName: string;
	destinationName: string;
	server: { url: string; headers: [string, string][] };
}
interface RouteEnvironment {
	storage: Pick<Storage, "getItem" | "setItem">;
	exclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
	migrate(options: MigrationOptions): Promise<MigrationResult>;
	createId(): string;
}
const routeKey = (sourceName: string) =>
	`lixray:replica-route:81:${encodeURIComponent(sourceName)}`;

export async function currentReplicaStorage(
	sourceName: string,
	server: MigrationOptions["server"],
	environment?: RouteEnvironment,
): Promise<string> {
	const env: RouteEnvironment = environment ?? {
		storage: globalThis.localStorage,
		exclusive: async (key, operation) =>
			await navigator.locks.request(key, operation),
		migrate: async (options) => {
			const { migrateOpfsReplica } =
				await import("@lix-js/storage-opfs/migration");
			return migrateOpfsReplica(options);
		},
		createId: () => crypto.randomUUID(),
	};
	const key = routeKey(sourceName);
	return env.exclusive(key, async () => {
		const stored = env.storage.getItem(key);
		if (stored) {
			const route: unknown = JSON.parse(stored);
			if (!isReplicaRoute(route, sourceName))
				throw new Error(
					"Stored replica routing metadata is invalid; retained data must be recovered.",
				);
			return route.activeName;
		}
		// A failed or interrupted attempt remains an unpublished recovery source.
		// Never reuse it as a clean target or delete it on a later retry.
		const stagedKey = `${key}:staged`;
		const priorStages: unknown = JSON.parse(
			env.storage.getItem(stagedKey) ?? "[]",
		);
		if (!isStringArray(priorStages))
			throw new Error("Replica migration journal is invalid");
		const destinationName = `${sourceName}:format81:${env.createId()}`;
		env.storage.setItem(
			stagedKey,
			JSON.stringify([...priorStages, destinationName]),
		);
		const result = await env.migrate({ sourceName, destinationName, server });
		if (
			result.destinationName !== destinationName ||
			!/^[a-f0-9]{64}$/.test(result.sourceDigest)
		)
			throw new Error(
				"Replica migration returned an invalid publication receipt",
			);
		const route: ReplicaRoute = {
			version: 1,
			activeName: destinationName,
			sourceName,
			sourceDigest: result.sourceDigest,
			retainedSources: [sourceName, ...priorStages],
		};
		// One atomic localStorage value is the publication boundary. It is written
		// only after the worker has validated and durably closed the destination.
		env.storage.setItem(key, JSON.stringify(route));
		return destinationName;
	});
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

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((item: unknown) => typeof item === "string")
	);
}
