import { repositoryHead } from "~/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useConsumeShellDirNavigation,
	useMarkRepositoryRouteSynced,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import {
	LIXRAY_HOME_EXTENSION_ID,
	lixrayHomeDirState,
} from "~/components/repository-home/host-extensions";
import { canonicalDirectoryPath } from "~/components/repository-home/lix-data";

export const Route = createFileRoute("/@{$namespace}/$repository/dir/$")({
	head: ({ params }) => repositoryHead(params, "dir"),
	component: RepositoryDirRoute,
});

/**
 * A folder URL drives the primary Files surface (flow A): the pinned Home
 * tab drills to the named folder in place. Folder tabs a user forked with
 * cmd-click keep their own state and claim the URL only while active.
 */
function RepositoryDirRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const consumeShellDirNavigation = useConsumeShellDirNavigation();
	const { _splat: dirSplat } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();

	useEffect(() => {
		if (!atelier || !dirSplat) return;
		if (branch && activeBranchId !== branch) return;
		// lixrayHomeDirState canonicalizes a trailing slash supplied by the URL
		// to lix_directory's persisted path contract.
		const dirPath = `/${dirSplat}`;
		// A URL written by the shell itself (a folder tab activated or drilled)
		// already has the right surface active — hydrating Home here would
		// steal focus from it.
		if (consumeShellDirNavigation(canonicalDirectoryPath(dirPath))) {
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
			// restore racing the command can wipe fresh state, leaving the
			// promise pending forever — so a quiet open is retried too.
			const timer = setTimeout(() => {
				if (!cancelled && !settled && retriesLeft > 0) {
					attempt(retriesLeft - 1);
				}
			}, 800);
			atelier.views
				.open(LIXRAY_HOME_EXTENSION_ID, { state: lixrayHomeDirState(dirPath) })
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
					console.error(
						"Unable to open the requested repository folder",
						error,
					);
					// Synced even on real failure: tab activations should drive
					// the URL again rather than staying frozen at a dead deep link.
					markRouteSynced();
				});
		};
		attempt(5);
		return () => {
			cancelled = true;
		};
	}, [
		activeBranchId,
		atelier,
		branch,
		consumeShellDirNavigation,
		dirSplat,
		markRouteSynced,
	]);

	return null;
}
