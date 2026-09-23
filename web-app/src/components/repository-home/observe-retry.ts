/** Reopen an observation when its transport fails, while retaining the last frame. */
export function isRetryableObserveError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error))
		return false;
	return (
		error.code === "LIX_TRANSPORT_NETWORK" ||
		error.code === "LIX_REMOTE_UNAVAILABLE"
	);
}

function waitForReconnect(attempt: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const delay = Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000);
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timeout);
			globalThis.removeEventListener?.("online", finish);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timeout = setTimeout(finish, delay);
		globalThis.addEventListener?.("online", finish, { once: true });
		signal.addEventListener("abort", finish, { once: true });
	});
}

export async function consumeObservedRowsWithRetry<T>({
	observe,
	onFrame,
	onError,
	signal,
	wait = waitForReconnect,
}: {
	observe: () => AsyncIterableIterator<T>;
	onFrame: (frame: T) => void;
	onError: (error: unknown) => void;
	signal: AbortSignal;
	wait?: (attempt: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
	let retryAttempt = 0;
	let lastTransportFailureAt = 0;
	while (!signal.aborted) {
		let events: AsyncIterableIterator<T> | undefined;
		try {
			events = observe();
			for await (const frame of events) {
				if (signal.aborted) return;
				onFrame(frame);
			}
			return;
		} catch (error) {
			if (signal.aborted) return;
			if (!isRetryableObserveError(error)) {
				onError(error);
				return;
			}
			// A partial replica may yield a cached local frame before every failed
			// remote attempt. Only a sustained interval without transport errors
			// begins a new retry sequence.
			const now = Date.now();
			if (now - lastTransportFailureAt > 30_000) retryAttempt = 0;
			lastTransportFailureAt = now;
		} finally {
			try {
				await events?.return?.();
			} catch {
				// The stream has already failed or is closing during unmount.
			}
		}
		await wait(retryAttempt++, signal);
	}
}
