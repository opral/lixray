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
