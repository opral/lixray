import { compatibility } from "@lix-js/sdk/compatibility";
import type { RemoteLixFetch } from "@lix-js/sdk";
import { repositoryOpenDiagnostics } from "./repository-open-telemetry.ts";

const ADMISSION_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000];
const RETRYABLE_ADMISSION_CODES = new Set([
	"LIX_ERROR_RECOVERING",
	"LIX_ERROR_MIGRATING",
	"LIX_REPOSITORY_MIGRATING",
	"LIX_CATALOG_UNAVAILABLE",
	"LIX_ERROR_SHUTTING_DOWN",
	"LIX_ERROR_CAPACITY",
]);

async function recoveryError(
	response: Response,
	stage: "admission" | "replacement",
	attempts: number,
) {
	let code: string | undefined;
	let retryable = false;
	let diagnostics: Record<string, string | number | boolean | null> = {};
	try {
		const body = (await response.json()) as {
			error?: { code?: unknown; details?: { retryable?: unknown } };
		};
		diagnostics = repositoryOpenDiagnostics({ details: body.error?.details });
		if (
			typeof body.error?.code === "string" &&
			/^LIX_[A-Z0-9_]{1,100}$/.test(body.error.code)
		) {
			code = body.error.code;
			retryable =
				body.error.details?.retryable !== false &&
				RETRYABLE_ADMISSION_CODES.has(code);
		}
	} catch {
		/* Preserve bounded diagnostics for non-JSON gateway responses too. */
	}
	return Object.assign(
		new Error(
			`Replica recovery ${stage} returned HTTP ${response.status}${code ? ` (${code})` : ""}`,
		),
		{
			name: "LixError",
			code: code ?? "LIX_REPLICA_RECOVERY_FAILED",
			status: response.status,
			details: {
				...diagnostics,
				httpStatus: response.status,
				recoveryStage: stage,
				recoveryAttempts: attempts,
				retryable: stage === "admission" && retryable,
				admissionRetryExhausted: false,
			},
		},
	);
}

/** Only retry admission before any replica retirement; never replay replacement POSTs. */
async function recoveryAdmission(
	fetcher: RemoteLixFetch,
	url: URL,
	headers: Headers,
	signal: AbortSignal,
) {
	let lastError: Awaited<ReturnType<typeof recoveryError>> | undefined;
	try {
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			const response = await fetcher(url, { headers, signal });
			if (response.ok) return response;
			const error = await recoveryError(response, "admission", attempt + 1);
			if (response.status !== 503 || !error.details.retryable) {
				lastError = undefined;
				throw error;
			}
			lastError = error;
			// The enclosing recovery deadline bounds this safe GET loop.
			// A migration can legitimately outlast the initial backoff ramp.
			const delay =
				ADMISSION_RETRY_DELAYS_MS[
					Math.min(attempt, ADMISSION_RETRY_DELAYS_MS.length - 1)
				]!;
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					clearTimeout(timer);
					reject(
						signal.reason instanceof Error
							? signal.reason
							: new DOMException("Replica recovery was aborted", "AbortError"),
					);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, delay);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
		}
	} catch (error) {
		if (
			lastError &&
			signal.aborted &&
			(signal.reason instanceof Error ||
				signal.reason instanceof DOMException) &&
			signal.reason.name === "TimeoutError"
		) {
			lastError.details.admissionRetryExhausted = true;
			Object.assign(lastError.details, { recoveryDeadlineExceeded: true });
			throw lastError;
		}
		throw error;
	}
}

type Route = { activeName: string; retainedSources: string[] };
type ReplacementIntent = {
	version: 1;
	failedName: string;
	replacementId: string;
};
const key = (source: string) =>
	`lixray:replica-replacement:v1:${encodeURIComponent(source)}`;
const intentKey = (source: string) => `${key(source)}:intent`;

function isReplacementName(name: unknown, source: string): name is string {
	return (
		typeof name === "string" &&
		(name === source ||
			(name.startsWith(`${source}:replacement:`) &&
				name.length > `${source}:replacement:`.length))
	);
}

function readRoute(
	source: string,
	storage: Pick<Storage, "getItem"> = localStorage,
): Route {
	const raw = storage.getItem(key(source));
	if (raw === null) return { activeName: source, retainedSources: [] };
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		!("activeName" in value) ||
		!isReplacementName(value.activeName, source) ||
		value.activeName === source ||
		!("retainedSources" in value) ||
		!Array.isArray(value.retainedSources) ||
		!value.retainedSources.every((name: unknown) =>
			isReplacementName(name, source),
		) ||
		new Set(value.retainedSources).size !== value.retainedSources.length ||
		value.retainedSources.includes(value.activeName)
	)
		throw new Error(
			"Invalid replica replacement record; retained local data requires recovery.",
		);
	return value as Route;
}

function readIntent(source: string): ReplacementIntent | undefined {
	const raw = localStorage.getItem(intentKey(source));
	if (raw === null) return undefined;
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("failedName" in value) ||
		!isReplacementName(value.failedName, source) ||
		!("replacementId" in value) ||
		!isReplacementName(value.replacementId, source) ||
		value.replacementId === source ||
		value.replacementId === value.failedName
	)
		throw new Error(
			"Invalid replica replacement intent; retained local data requires recovery.",
		);
	return value as ReplacementIntent;
}

export function retainedReplicaCount(source: string): number {
	return readRoute(source).retainedSources.length;
}

/** Names of prior OPFS databases retained by app-managed replica replacement. */
export function retainedReplicaStorageNames(
	source: string,
	storage: Pick<Storage, "getItem"> = localStorage,
): string[] {
	return [...readRoute(source, storage).retainedSources];
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
			let intent = readIntent(options.source);
			if (intent && intent.failedName !== options.failedName) {
				if (route.retainedSources.includes(intent.failedName)) {
					// The pointer was published before a crash while removing the old intent.
					// Overwrite it with a fresh intent for this now-active source.
					intent = undefined;
				} else {
					throw new Error(
						"Replica replacement intent does not match the active source; retained local data requires recovery.",
					);
				}
			}
			if (!intent) {
				intent = {
					version: 1,
					failedName: options.failedName,
					replacementId: `${options.source}:replacement:${crypto.randomUUID()}`,
				};
				// Persist the destination before the server can durably retire the source.
				// If this write fails, no external mutation has happened yet.
				localStorage.setItem(intentKey(options.source), JSON.stringify(intent));
			}
			const replacementId = intent.replacementId;
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
			const handshake = await recoveryAdmission(
				options.fetch,
				url,
				headers,
				signal,
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
				if (!response.ok) throw await recoveryError(response, "replacement", 1);
				const result = (await response.json()) as { replicaId?: unknown };
				if (
					typeof result.replicaId !== "string" ||
					!isReplacementName(result.replicaId, options.source) ||
					result.replicaId === options.source ||
					result.replicaId === options.failedName
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
				// The authority may return an existing canonical mapping created by an
				// older client that lost its local route write. The authenticated
				// source-keyed replacement endpoint is authoritative for this ID.
				try {
					localStorage.removeItem(intentKey(options.source));
				} catch {
					// A stale intent is harmless once the route points elsewhere.
				}
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
