import { compatibility } from "@lix-js/sdk/compatibility";
import type { RemoteLixFetch } from "@lix-js/sdk";

type Route = { activeName: string; retainedSources: string[] };
const key = (source: string) =>
	`lixray:replica-replacement:v1:${encodeURIComponent(source)}`;

function readRoute(source: string): Route {
	const raw = localStorage.getItem(key(source));
	if (raw === null) return { activeName: source, retainedSources: [] };
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		!("activeName" in value) ||
		typeof value.activeName !== "string" ||
		!value.activeName.startsWith(`${source}:replacement:`) ||
		!("retainedSources" in value) ||
		!Array.isArray(value.retainedSources) ||
		!value.retainedSources.every((name: unknown) => typeof name === "string")
	)
		throw new Error(
			"Invalid replica replacement record; retained local data requires recovery.",
		);
	return value as Route;
}

export function retainedReplicaCount(source: string): number {
	return readRoute(source).retainedSources.length;
}

export function activeReplicaStorage(source: string): string {
	return readRoute(source).activeName;
}

/** Publish the local pointer only after the authority durably retires the source. */
export async function replaceRepositoryReplica(options: {
	source: string;
	failedName: string;
	url: URL;
	headers: () => Promise<Record<string, string>>;
	fetch: RemoteLixFetch;
	signal?: AbortSignal;
}): Promise<string> {
	return navigator.locks.request(
		`lixray:replica-replacement:${options.source}`,
		{ signal: options.signal },
		async () => {
			const route = readRoute(options.source);
			if (route.activeName !== options.failedName) return route.activeName;
			const replacementId = `${options.source}:replacement:${crypto.randomUUID()}`;
			const url = new URL(options.url);
			url.pathname = url.pathname.replace(/\/lix\/([^/]+)\/?$/, "/lix/v1/$1");
			const signal = options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
				: AbortSignal.timeout(30_000);
			const headers = new Headers(await options.headers());
			headers.set(
				"lix-server-protocol-version",
				String(compatibility.serverProtocolVersion),
			);
			headers.set(
				"lix-sync-protocol-version",
				String(compatibility.syncProtocolVersion),
			);
			const handshake = await options.fetch(url, { headers, signal });
			if (!handshake.ok)
				throw new Error(
					`Replica recovery admission returned HTTP ${handshake.status}`,
				);
			const identity = (await handshake.json()) as { sessionId?: unknown };
			if (typeof identity.sessionId !== "string")
				throw new Error("Replica recovery admission returned no session");
			headers.set("lix-session-id", identity.sessionId);
			headers.set("content-type", "application/json");
			try {
				const response = await options.fetch(`${url}/sync/replica/replace`, {
					method: "POST",
					headers,
					signal,
					body: JSON.stringify({
						replicaId: options.failedName,
						replacementId,
					}),
				});
				if (!response.ok)
					throw new Error(
						`Replica replacement returned HTTP ${response.status}`,
					);
				const result = (await response.json()) as { replicaId?: unknown };
				if (
					typeof result.replicaId !== "string" ||
					!result.replicaId.startsWith(`${options.source}:replacement:`)
				)
					throw new Error("Authority returned an invalid replacement identity");
				localStorage.setItem(
					key(options.source),
					JSON.stringify({
						activeName: result.replicaId,
						retainedSources: [
							...new Set([...route.retainedSources, options.failedName]),
						],
					}),
				);
				return result.replicaId;
			} finally {
				await options
					.fetch(`${url}/session`, {
						method: "DELETE",
						headers,
						signal: AbortSignal.timeout(5_000),
					})
					.catch(() => undefined);
			}
		},
	);
}
