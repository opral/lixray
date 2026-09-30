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
