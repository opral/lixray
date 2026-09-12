/** Wait for the shell's own route commit without mistaking it for external navigation. */
export function createShellNavigationQueue() {
	let pending: { target: string; completion: Promise<void> } | null = null;
	return {
		async settle(pathname: () => string): Promise<string | null> {
			const startingPath = pathname();
			const own = pending;
			if (own) await own.completion;
			const current = pathname();
			return current === startingPath || current === own?.target
				? current
				: null;
		},
		async navigate(target: string, commit: () => Promise<void>): Promise<void> {
			const own = { target, completion: Promise.resolve().then(commit) };
			pending = own;
			try {
				await own.completion;
			} finally {
				if (pending === own) pending = null;
			}
		},
	};
}

/** Keep a shell-issued route idempotent across React effect cleanup/replay. */
export function createShellRouteHydrationGuard() {
	let previous: {
		owner: object | null;
		route: string;
		shellIssued: boolean;
	} | null = null;
	return {
		reset() {
			previous = null;
		},
		isShellIssued(
			owner: object | null,
			route: string,
			consume: () => boolean,
		): boolean {
			if (
				previous?.owner === owner &&
				previous.route === route &&
				previous.shellIssued
			)
				return true;
			const shellIssued = consume();
			previous = { owner, route, shellIssued };
			return shellIssued;
		},
	};
}
