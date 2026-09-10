import { repositoryHead } from "~/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
	useConsumeShellEntityNavigation,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import { LIXRAY_PEOPLE_EXTENSION_ID } from "~/components/repository-home/host-extensions";

export const Route = createFileRoute("/@{$namespace}/$repository/team")({
	head: ({ params, match }) => repositoryHead(params, "team", match.search),
	component: RepositoryTeamRoute,
});

/**
 * The People tab opened as a central content tab (3c). The URL names the
 * active tab, exactly like /file/ and /dir/; the tab itself is branch-
 * independent, so no branch gate is needed here.
 */
function RepositoryTeamRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const consumeShellNavigation = useConsumeShellEntityNavigation();

	useEffect(() => {
		if (!atelier) return;
		if (consumeShellNavigation("view:team")) {
			markRouteSynced();
			return;
		}
		let cancelled = false;
		// "Shell unmounted" is a transient: the dev double-mount (and HMR)
		// tears the shell down and remounts it on the same instance, so the
		// command just needs another try — the effect deps never change.
		const attempt = (retriesLeft: number) => {
			let settled = false;
			// The open resolves only once the view is ACTIVE. A session-state
			// restore racing the command can wipe the fresh tab, leaving the
			// promise pending forever — so a quiet open is retried too.
			const timer = setTimeout(() => {
				if (!cancelled && !settled && retriesLeft > 0) {
					attempt(retriesLeft - 1);
				}
			}, 800);
			atelier.views
				.open(LIXRAY_PEOPLE_EXTENSION_ID)
				.then(() => {
					settled = true;
					clearTimeout(timer);
					if (!cancelled) markRouteSynced();
				})
				.catch((error: unknown) => {
					settled = true;
					clearTimeout(timer);
					if (cancelled) return;
					const transient =
						error instanceof Error && error.message.includes("shell unmounted");
					if (transient && retriesLeft > 0) {
						setTimeout(() => {
							if (!cancelled) attempt(retriesLeft - 1);
						}, 150);
						return;
					}
					console.error("Unable to open the People tab", error);
					// Synced even on real failure: tab activations should drive
					// the URL again rather than staying frozen at a dead deep link.
					markRouteSynced();
				});
		};
		attempt(5);
		return () => {
			cancelled = true;
		};
	}, [atelier, markRouteSynced, consumeShellNavigation]);

	return null;
}
