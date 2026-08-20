import { releaseRepositoryBrowserReplicaClaimsForPageUnload } from "./repository-opfs-cache.ts";

interface AsyncCloseable {
	close(): Promise<void>;
	terminateForPageUnload?(): void;
}

interface ManagedResource {
	resourcePromise: Promise<AsyncCloseable>;
	resource?: AsyncCloseable;
	leaseCount: number;
	closeTimer?: ReturnType<typeof setTimeout>;
	closePromise?: Promise<void>;
}

export interface ManagedResourceLease<T> {
	readonly resource: T;
	release(): void;
}

const managedResources = new Map<string, ManagedResource>();

export async function acquireManagedRepositoryResource<
	T extends AsyncCloseable,
>(key: string, open: () => Promise<T>): Promise<ManagedResourceLease<T>> {
	for (;;) {
		const existing = managedResources.get(key);
		if (existing?.closePromise) {
			await existing.closePromise.catch(() => undefined);
			continue;
		}

		const managed = existing ?? createManagedResource(key, open);
		if (managed.closeTimer) {
			clearTimeout(managed.closeTimer);
			managed.closeTimer = undefined;
		}
		managed.leaseCount += 1;

		try {
			const resource = (await managed.resourcePromise) as T;
			managed.resource = resource;
			let released = false;
			return {
				resource,
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
	open: () => Promise<T>,
): ManagedResource {
	const managed: ManagedResource = {
		resourcePromise: open(),
		leaseCount: 0,
	};
	managedResources.set(key, managed);
	void managed.resourcePromise.catch(() => {
		if (managedResources.get(key) === managed) managedResources.delete(key);
	});
	return managed;
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
	let close: Promise<void>;
	try {
		close = managed.resource
			? managed.resource.close()
			: managed.resourcePromise.then((resource) => resource.close());
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
	// Let the next document reclaim its sessionStorage-backed replica identity
	// before aborting workers and closing the current document's resources.
	releaseRepositoryBrowserReplicaClaimsForPageUnload();
	for (const [key, managed] of managedResources) {
		if (managed.closeTimer) clearTimeout(managed.closeTimer);
		managed.closeTimer = undefined;
		if (managed.resource?.terminateForPageUnload) {
			try {
				managed.resource.terminateForPageUnload();
			} finally {
				managed.closePromise = Promise.resolve();
				if (managedResources.get(key) === managed) managedResources.delete(key);
			}
		} else {
			closeManagedResource(key, managed);
		}
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
