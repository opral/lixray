import { repositoryHead } from "~/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
	useBeginRepositoryRouteNavigation,
	useConsumeShellEntityNavigation,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";

const SQL_EXPLORER_EXTENSION_ID = "sql_explorer";

export const Route = createFileRoute("/@{$namespace}/$repository/sql")({
	head: ({ params, match }) => {
		const head = repositoryHead(params, "sql", match.search);
		return {
			...head,
			meta: [...head.meta, { name: "robots", content: "noindex" }],
		};
	},
	component: RepositorySqlRoute,
});

/**
 * The SQL Explorer opened as a central content tab. The URL names the active
 * tab, exactly like /team and /settings — closing the tab or activating
 * another one navigates back naturally.
 */
function RepositorySqlRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const beginRouteNavigation = useBeginRepositoryRouteNavigation();
	const consumeShellNavigation = useConsumeShellEntityNavigation();

	useEffect(() => {
		if (!atelier) return;
		if (consumeShellNavigation("view:sql")) {
			markRouteSynced();
			return;
		}
		const controller = beginRouteNavigation();
		// "Shell unmounted" is a transient: the dev double-mount (and HMR)
		// tears the shell down and remounts it on the same instance, so the
		// command just needs another try — the effect deps never change.
		const attempt = (retriesLeft: number) => {
			let settled = false;
			// The open resolves only once the view is ACTIVE. A session-state
			// restore racing the command can wipe the fresh tab, leaving the
			// promise pending forever — so a quiet open is retried too.
			const timer = setTimeout(() => {
				if (!controller.signal.aborted && !settled && retriesLeft > 0) {
					attempt(retriesLeft - 1);
				}
			}, 800);
			atelier.views
				// Activated if open; otherwise beside the tab in front, never in
				// its place (a reload or Back to /sql must not close a tab).
				.open(SQL_EXPLORER_EXTENSION_ID, {
					newTab: true,
					signal: controller.signal,
				})
				.then(() => {
					settled = true;
					clearTimeout(timer);
					if (!controller.signal.aborted) markRouteSynced();
				})
				.catch((error: unknown) => {
					settled = true;
					clearTimeout(timer);
					if (controller.signal.aborted) return;
					const transient =
						error instanceof Error && error.message.includes("shell unmounted");
					if (transient && retriesLeft > 0) {
						setTimeout(() => {
							if (!controller.signal.aborted) attempt(retriesLeft - 1);
						}, 150);
						return;
					}
					console.error("Unable to open the SQL Explorer tab", error);
					// Synced even on real failure: tab activations should drive
					// the URL again rather than staying frozen at a dead deep link.
					markRouteSynced();
				});
		};
		attempt(5);
		return () => {
			controller.abort();
		};
	}, [atelier, beginRouteNavigation, markRouteSynced, consumeShellNavigation]);

	return null;
}
