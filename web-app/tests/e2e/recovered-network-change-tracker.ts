/**
 * Correlate a transient online Chromium network-change console error with its
 * failed script request and a later completed reload of that exact URL.
 */
export function createRecoveredNetworkChangeTracker<
	TRequest extends { url(): string },
>() {
	type Failure = {
		id: number;
		requestStartOrder: number;
		failedOrder: number;
		consoleOrder: number | null;
		recovered: boolean;
	};
	let eventOrder = 0;
	let nextFailureId = 0;
	const requestStartOrder = new WeakMap<TRequest, number>();
	const failuresByUrl = new Map<string, Failure[]>();
	const failuresById = new Map<number, Failure>();

	return {
		started(request: TRequest) {
			requestStartOrder.set(request, ++eventOrder);
		},
		failed(request: TRequest) {
			const startOrder = requestStartOrder.get(request);
			if (startOrder === undefined) return;
			const failure = {
				id: ++nextFailureId,
				requestStartOrder: startOrder,
				failedOrder: ++eventOrder,
				consoleOrder: null,
				recovered: false,
			};
			const failures = failuresByUrl.get(request.url()) ?? [];
			failures.push(failure);
			failuresByUrl.set(request.url(), failures);
			failuresById.set(failure.id, failure);
		},
		console(url: string) {
			const now = ++eventOrder;
			const failure = failuresByUrl
				.get(url)
				?.find(
					(attempt) =>
						attempt.consoleOrder === null && attempt.failedOrder < now,
				);
			if (!failure) return null;
			failure.consoleOrder = now;
			return failure.id;
		},
		completedReload(request: TRequest) {
			const startOrder = requestStartOrder.get(request);
			if (startOrder === undefined) return null;
			const now = ++eventOrder;
			const failure = failuresByUrl
				.get(request.url())
				?.find(
					(attempt) =>
						!attempt.recovered &&
						attempt.requestStartOrder < attempt.failedOrder &&
						attempt.failedOrder < startOrder &&
						attempt.consoleOrder !== null &&
						attempt.consoleOrder < startOrder &&
						attempt.consoleOrder < now,
				);
			if (!failure) return null;
			failure.recovered = true;
			return failure.id;
		},
		recovered(failureId: number) {
			return failuresById.get(failureId)?.recovered ?? false;
		},
	};
}
