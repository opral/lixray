/** Match a delayed Chromium console error to a request made while offline. */
export function createOfflineConsoleRequestTracker<
	TRequest extends { url(): string },
>() {
	const requestsByUrl = new Map<string, Set<TRequest>>();
	return {
		started(request: TRequest) {
			const requests = requestsByUrl.get(request.url()) ?? new Set<TRequest>();
			requests.add(request);
			requestsByUrl.set(request.url(), requests);
		},
		finished(request: TRequest) {
			const requests = requestsByUrl.get(request.url());
			requests?.delete(request);
			if (requests?.size === 0) requestsByUrl.delete(request.url());
		},
		consume(url: string) {
			const request = requestsByUrl.get(url)?.values().next().value;
			if (!request) return false;
			this.finished(request);
			return true;
		},
	};
}
