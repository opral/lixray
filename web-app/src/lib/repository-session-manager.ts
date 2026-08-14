interface AsyncCloseable {
	close(): Promise<void>;
}

interface ManagedResource {
	resourcePromise: Promise<AsyncCloseable>;
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
	// live repository resource instead of racing a second IndexedDB open.
	managed.closeTimer = setTimeout(() => {
		managed.closeTimer = undefined;
		if (managed.leaseCount !== 0) return;
		managed.closePromise = managed.resourcePromise
			.then((resource) => resource.close())
			.finally(() => {
				if (managedResources.get(key) === managed) {
					managedResources.delete(key);
				}
			});
		void managed.closePromise.catch(() => undefined);
	}, 0);
}
