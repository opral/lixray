interface AsyncCloseable {
	close(): Promise<void>;
}

interface ManagedResource {
	resourcePromise: Promise<AsyncCloseable>;
	resource?: AsyncCloseable;
	openController: AbortController;
	leaseCount: number;
	closeTimer?: ReturnType<typeof setTimeout>;
	closePromise?: Promise<void>;
}

export interface ManagedResourceLease<T> {
	readonly resource: T;
	readonly acquisition: "created" | "joined" | "reused";
	release(): void;
}

const managedResources = new Map<string, ManagedResource>();

export async function acquireManagedRepositoryResource<
	T extends AsyncCloseable,
>(
	key: string,
	open: (signal: AbortSignal) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<ManagedResourceLease<T>> {
	for (;;) {
		options.signal?.throwIfAborted();
		const existing = managedResources.get(key);
		if (existing?.closePromise) {
			await waitForResource(
				existing.closePromise.catch(() => undefined),
				options.signal,
			);
			continue;
		}

		const managed = existing ?? createManagedResource(key, open);
		const acquisition = !existing
			? "created"
			: existing.resource
				? "reused"
				: "joined";
		if (managed.closeTimer) {
			clearTimeout(managed.closeTimer);
			managed.closeTimer = undefined;
		}
		managed.leaseCount += 1;

		try {
			const resource = (await waitForResource(
				managed.resourcePromise,
				options.signal,
			)) as T;
			managed.resource = resource;
			let released = false;
			return {
				resource,
				acquisition,
				release() {
					if (released) return;
					released = true;
					releaseManagedResource(key, managed);
				},
			};
		} catch (error) {
			releaseManagedResource(key, managed);
			throw error;
		}
	}
}

function createManagedResource<T extends AsyncCloseable>(
	key: string,
	open: (signal: AbortSignal) => Promise<T>,
): ManagedResource {
	const openController = new AbortController();
	const managed: ManagedResource = {
		resourcePromise: open(openController.signal),
		openController,
		leaseCount: 0,
	};
	managedResources.set(key, managed);
	void managed.resourcePromise.catch(() => {
		if (managedResources.get(key) === managed) managedResources.delete(key);
	});
	return managed;
}

function waitForResource<T>(
	resourcePromise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return resourcePromise;
	return new Promise<T>((resolve, reject) => {
		// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal permits arbitrary reasons; match throwIfAborted exactly.
		const abort = () => reject(abortError(signal));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			signal.removeEventListener("abort", abort);
			abort();
			return;
		}
		void resourcePromise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason;
}

function releaseManagedResource(key: string, managed: ManagedResource): void {
	managed.leaseCount -= 1;
	if (
		managed.leaseCount !== 0 ||
		managed.closeTimer ||
		managed.closePromise ||
		managedResources.get(key) !== managed
	) {
		return;
	}

	// React Strict Mode releases and reacquires effects synchronously in
	// development. Deferring the final close lets that reacquisition reuse the
	// live repository resource instead of racing a second OPFS owner open.
	managed.closeTimer = setTimeout(() => {
		managed.closeTimer = undefined;
		if (managed.leaseCount !== 0) return;
		closeManagedResource(key, managed);
	}, 0);
}

function closeManagedResource(key: string, managed: ManagedResource): void {
	if (managed.closePromise) return;
	if (!managed.resource) managed.openController.abort();
	let close: Promise<void>;
	try {
		close = managed.resource
			? managed.resource.close()
			: managed.resourcePromise.then(
					(resource) => resource.close(),
					() => undefined,
				);
	} catch (error) {
		close = Promise.reject(
			error instanceof Error ? error : new Error(String(error)),
		);
	}
	managed.closePromise = close.finally(() => {
		if (managedResources.get(key) === managed) {
			managedResources.delete(key);
		}
	});
	void managed.closePromise.catch(() => undefined);
}

export function closeManagedRepositoryResourcesForPageUnload(): void {
	for (const [key, managed] of managedResources) {
		if (managed.closeTimer) clearTimeout(managed.closeTimer);
		managed.closeTimer = undefined;
		closeManagedResource(key, managed);
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", (event) => {
		// BFCache freezes and resumes the same page. A real unload cannot run the
		// deferred React release timer, so close synchronously enough to abort the
		// browser sync transport before the document disappears.
		if (!event.persisted) closeManagedRepositoryResourcesForPageUnload();
	});
}
