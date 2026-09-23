import { createHash } from "node:crypto";

type ObservedResponse = {
	method: string;
	url: string;
	status: number;
	body: Uint8Array | null;
};
type PendingResponse = {
	key: string;
	url: string;
	requestBodyBytes: number;
	requestBodySha256: string;
	failureSequence: number;
};

export function isRetainedBodyUpload(method: string, value: string): boolean {
	if (method !== "POST") return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			/^\/lix\/v1\/[^/]+\/sync\/retained-bodies$/.test(url.pathname) &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

/** A failed retained-body wave stays a failure until its exact replay succeeds. */
export function createRetainedBodyRecoveryTracker() {
	let sequence = 0;
	let pending: PendingResponse[] = [];
	const recovered: Array<
		Omit<PendingResponse, "key"> & { successSequence: number }
	> = [];
	return {
		/** True means a 409 was retained for later replay verification. */
		observe(response: ObservedResponse): boolean {
			const current = ++sequence;
			if (
				!isRetainedBodyUpload(response.method, response.url) ||
				!response.body?.byteLength
			)
				return false;
			// Compare bytes, not parsed JSON or an attempt ID: neither proves the
			// complete upload is identical. The digest is only for diagnostics.
			const body = Buffer.from(response.body);
			const key = JSON.stringify([response.url, body.toString("base64")]);
			if (response.status === 409) {
				pending.push({
					key,
					url: response.url,
					requestBodyBytes: body.byteLength,
					requestBodySha256: createHash("sha256").update(body).digest("hex"),
					failureSequence: current,
				});
				return true;
			}
			if (response.status === 200) {
				pending = pending.filter((failure) => {
					if (failure.key !== key) return true;
					recovered.push({
						url: failure.url,
						requestBodyBytes: failure.requestBodyBytes,
						requestBodySha256: failure.requestBodySha256,
						failureSequence: failure.failureSequence,
						successSequence: current,
					});
					return false;
				});
			}
			return false;
		},
		failures: () => pending.map(({ url }) => `409 ${url}`),
		recovered: () => recovered.map((event) => ({ ...event })),
	};
}

/** A merge CAS conflict is expected only when the server supplies its exact typed code. */
export function isRetryableMergeConflict(
	method: string,
	value: string,
	status: number,
	body: unknown,
): boolean {
	if (method !== "POST" || status !== 409) return false;
	try {
		const url = new URL(value);
		if (
			!/^\/lix\/v1\/[^/]+\/sync\/merge$/.test(url.pathname) ||
			url.search ||
			url.hash ||
			!["http:", "https:"].includes(url.protocol)
		)
			return false;
	} catch {
		return false;
	}
	if (!body || typeof body !== "object" || !("error" in body)) return false;
	const error = body.error;
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "LIX_TRANSACTION_CONFLICT"
	);
}

/** A merge 409 is recovered when the same request later succeeds. */
export function createMergeReplayTracker() {
	const pending = new Map<string, { url: string; count: number }>();
	const rejectedFailures: string[] = [];
	let recoveredAttempts = 0;
	const requestKey = (response: ObservedResponse): string | null => {
		if (response.method !== "POST" || !response.body?.byteLength) return null;
		let url: URL;
		try {
			url = new URL(response.url);
		} catch {
			return null;
		}
		if (
			!/^\/lix\/v1\/[^/]+\/sync\/merge$/.test(url.pathname) ||
			url.search ||
			url.hash ||
			!["http:", "https:"].includes(url.protocol)
		)
			return null;
		return JSON.stringify([
			response.url,
			Buffer.from(response.body).toString("base64"),
		]);
	};
	return {
		/** True when this 409 is tracked until an exact replay succeeds. */
		observe(response: ObservedResponse): boolean {
			if (![200, 409].includes(response.status)) return false;
			const key = requestKey(response);
			if (!key) return false;
			if (response.status === 409) {
				pending.set(key, {
					url: response.url,
					count: (pending.get(key)?.count ?? 0) + 1,
				});
				return true;
			}
			const recovered = pending.get(key)?.count ?? 0;
			pending.delete(key);
			recoveredAttempts += recovered;
			return false;
		},
		/** A readable response cannot become acceptable through a later replay. */
		classifyConflict(response: ObservedResponse, retryable: boolean): boolean {
			if (response.status !== 409) return false;
			const key = requestKey(response);
			if (!key) return false;
			const entry = pending.get(key);
			if (entry) {
				if (entry.count <= 1) pending.delete(key);
				else pending.set(key, { ...entry, count: entry.count - 1 });
			}
			if (!retryable) rejectedFailures.push(`409 ${response.url}`);
			return Boolean(entry);
		},
		failures: () => [
			...rejectedFailures,
			...[...pending.values()].flatMap(({ url, count }) =>
				Array.from({ length: count }, () => `409 ${url}`),
			),
		],
		recovered: () => recoveredAttempts,
	};
}
