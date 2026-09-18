/** Pending URL navigation belongs to the current workspace, not to a user tab choice. */
export function createRepositoryRouteLifecycle() {
	const pending = new Set<AbortController>();
	return {
		begin() {
			const controller = new AbortController();
			pending.add(controller);
			controller.signal.addEventListener(
				"abort",
				() => pending.delete(controller),
				{ once: true },
			);
			return controller;
		},
		cancel() {
			for (const controller of pending) controller.abort();
		},
	};
}

/** Ignore a lookup result after the user has chosen a different workspace view. */
export async function readRepositoryRoute<T>(
	signal: AbortSignal,
	read: () => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	const result = await read();
	signal.throwIfAborted();
	return result;
}
