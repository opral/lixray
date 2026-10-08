type PublicationResponse = {
	/** Fixture label for the browser page that issued the request. */
	source: string;
	replicaId: string | null;
	sessionId: string | null;
	/** Both publication routes allow omission; when present it scopes replay identity. */
	baselineLeaseId: string | null;
	method: string;
	url: string;
	status: number;
	body: Uint8Array | null;
};

// This caps raw request bytes retained as replay evidence. Requests above the
// test-side tracking budget remain unresolved instead of being declared safe.
export const MAX_PUBLICATION_REPLAY_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_TRACKED_PUBLICATION_FAILURES = 64;

type Observation = Omit<PublicationResponse, "body"> & {
	body: Buffer | null;
	sequence: number;
	key: string | null;
};

function publicationKey(response: PublicationResponse): string | null {
	if (
		response.method !== "POST" ||
		!response.source ||
		!response.replicaId ||
		!response.sessionId
	)
		return null;
	try {
		const url = new URL(response.url);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!/^\/lix\/v1\/[^/]+\/sync\/(?:push|retained-bodies)$/.test(
				url.pathname,
			) ||
			url.search ||
			url.hash
		)
			return null;
	} catch {
		return null;
	}
	return JSON.stringify([
		response.source,
		response.replicaId,
		response.sessionId,
		response.baselineLeaseId,
		response.url,
	]);
}

function isStorageUnavailable(body: string): boolean {
	try {
		const parsed: unknown = JSON.parse(body);
		if (!parsed || typeof parsed !== "object" || !("error" in parsed))
			return false;
		const error = parsed.error;
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "LIX_STORAGE_IO_UNAVAILABLE"
		);
	} catch {
		return false;
	}
}

/** A storage 503 is recovered only by an exact later publication replay. */
export function createTransientPublicationRecoveryTracker() {
	let sequence = 0;
	const failures: Array<{
		observation: Observation;
		typed: boolean;
		successSequence: number | null;
	}> = [];
	let retainedRequestBytes = 0;
	let untrackedFailureCount = 0;
	const classifyCode = (observation: Observation, errorCode: unknown) => {
		const failure = failures.find((entry) => entry.observation === observation);
		if (failure) failure.typed = errorCode === "LIX_STORAGE_IO_UNAVAILABLE";
	};
	return {
		observe(response: PublicationResponse): Observation {
			const key = publicationKey(response);
			const bodyLength = response.body?.byteLength ?? 0;
			const boundedBody =
				key &&
				bodyLength > 0 &&
				bodyLength <= MAX_PUBLICATION_REPLAY_REQUEST_BYTES
					? Buffer.from(
							response.body!.buffer,
							response.body!.byteOffset,
							response.body!.byteLength,
						)
					: null;
			const observation = {
				...response,
				body: boundedBody,
				sequence: ++sequence,
				key,
			};
			if (response.status === 200 && observation.key && observation.body) {
				for (const failure of failures) {
					if (
						failure.successSequence === null &&
						failure.observation.sequence < observation.sequence &&
						failure.observation.key === observation.key &&
						failure.observation.body?.equals(observation.body)
					) {
						failure.successSequence = observation.sequence;
						retainedRequestBytes -= failure.observation.body.byteLength;
						failure.observation.body = null;
					}
				}
			}
			if (response.status === 503) {
				if (
					failures.length >= MAX_TRACKED_PUBLICATION_FAILURES ||
					(key !== null &&
						(!observation.body ||
							retainedRequestBytes + observation.body.byteLength >
								MAX_PUBLICATION_REPLAY_REQUEST_BYTES))
				) {
					untrackedFailureCount += 1;
					observation.body = null;
				} else {
					if (observation.body) {
						observation.body = Buffer.from(observation.body);
					}
					failures.push({
						observation,
						typed: false,
						successSequence: null,
					});
					retainedRequestBytes += observation.body?.byteLength ?? 0;
				}
			}
			return observation;
		},
		classify(observation: Observation, responseBody: string) {
			classifyCode(
				observation,
				isStorageUnavailable(responseBody)
					? "LIX_STORAGE_IO_UNAVAILABLE"
					: null,
			);
		},
		classifyCode(observation: Observation, errorCode: unknown) {
			classifyCode(observation, errorCode);
		},
		recovered() {
			return failures
				.filter(
					({ observation, typed, successSequence }) =>
						typed &&
						observation.key &&
						successSequence !== null &&
						successSequence > observation.sequence,
				)
				.map(({ observation }) => observation);
		},
		failures() {
			const recovered = new Set(this.recovered());
			const unresolved = failures
				.filter(({ observation }) => !recovered.has(observation))
				.map(({ observation }) => `${observation.status} ${observation.url}`);
			if (untrackedFailureCount > 0)
				unresolved.push(
					`${untrackedFailureCount} additional 503 publication response(s) exceeded exact-replay tracking bounds`,
				);
			return unresolved;
		},
	};
}
