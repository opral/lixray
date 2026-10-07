type PushResponse = {
	source: string;
	replicaId: string | null;
	method: string;
	url: string;
	status: number;
	body: Uint8Array | null;
};

type Observation = PushResponse & { sequence: number; key: string | null };

function pushKey(response: PushResponse): string | null {
	if (
		response.method !== "POST" ||
		!response.replicaId ||
		!response.body?.byteLength
	)
		return null;
	try {
		const url = new URL(response.url);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!/^\/lix\/v1\/[^/]+\/sync\/push$/.test(url.pathname) ||
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
		response.url,
		Buffer.from(response.body).toString("base64"),
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

/** A storage 503 is recovered only by a later successful replay of its exact push. */
export function createTransientPushRecoveryTracker() {
	let sequence = 0;
	const successes: Observation[] = [];
	const failures: Array<{
		observation: Observation;
		typed: boolean;
	}> = [];
	const classifyCode = (observation: Observation, errorCode: unknown) => {
		const failure = failures.find((entry) => entry.observation === observation);
		if (failure) failure.typed = errorCode === "LIX_STORAGE_IO_UNAVAILABLE";
	};
	return {
		observe(response: PushResponse): Observation {
			const observation = {
				...response,
				sequence: ++sequence,
				key: pushKey(response),
			};
			if (response.status === 200 && observation.key)
				successes.push(observation);
			if (response.status === 503) failures.push({ observation, typed: false });
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
					({ observation, typed }) =>
						typed &&
						observation.key &&
						successes.some(
							(success) =>
								success.sequence > observation.sequence &&
								success.key === observation.key,
						),
				)
				.map(({ observation }) => observation);
		},
		failures() {
			const recovered = new Set(this.recovered());
			return failures
				.filter(({ observation }) => !recovered.has(observation))
				.map(({ observation }) => `${observation.status} ${observation.url}`);
		},
	};
}
