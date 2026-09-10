import { findLixEntity, parseEntityUrlSplat } from "~/lib/entity-url";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useConsumeShellEntityNavigation,
	useMarkRepositoryRouteSynced,
	useRepositoryActiveBranchId,
	useRepositoryDefaultBranchId,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import {
	LIXRAY_HOME_EXTENSION_ID,
	lixrayHomeDirState,
} from "~/components/repository-home/host-extensions";

export const Route = createFileRoute("/@{$namespace}/$repository/dir/$")({
	head: ({ params, match }) => repositoryHead(params, "dir", match.search),
	beforeLoad: ({ params }) => {
		if (!parseEntityUrlSplat(params._splat)) notFound({ throw: true });
	},
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
	const consumeShellNavigation = useConsumeShellEntityNavigation();
	const { _splat: dirSplat, namespace, repository } = Route.useParams();
	const entityId = parseEntityUrlSplat(dirSplat)?.id;
	const defaultBranchId = useRepositoryDefaultBranchId();
	const navigate = useNavigate();
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();

	useEffect(() => {
		if (!atelier || !entityId) return;
		if (activeBranchId !== (branch ?? defaultBranchId)) return;
		if (consumeShellNavigation(`directory:${entityId}`)) {
			markRouteSynced();
			return;
		}
		let cancelled = false;
		void findLixEntity(atelier.lix, "directory", { id: entityId })
			.then((entity) => {
				if (cancelled) return;
				if (!entity) {
					markRouteSynced();
					void navigate({
						to: "/@{$namespace}/$repository",
						params: { namespace, repository },
						search: branch ? { branch } : {},
						replace: true,
					});
					return;
				}
				// lixrayHomeDirState canonicalizes a trailing slash supplied by the URL
				// to lix_directory's persisted path contract.
				const dirPath = entity.path;
				// A URL written by the shell itself (a folder tab activated or drilled)
				// already has the right surface active — hydrating Home here would
				// steal focus from it.

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
						.open(LIXRAY_HOME_EXTENSION_ID, {
							state: lixrayHomeDirState(dirPath),
						})
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
								error instanceof Error &&
								error.message.includes("shell unmounted");
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
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					console.error("Unable to resolve directory", error);
					markRouteSynced();
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		activeBranchId,
		atelier,
		branch,
		consumeShellNavigation,
		entityId,
		defaultBranchId,
		namespace,
		repository,
		navigate,
		markRouteSynced,
	]);

	return null;
}
