import { readRepositoryRoute } from "~/lib/repository-route-lifecycle";
import {
	canonicalEntitySplat,
	findLixEntity,
	parseEntityUrlSplat,
} from "~/lib/entity-url";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	useConsumeShellEntityNavigation,
	useMarkRepositoryRouteSynced,
	useBeginRepositoryRouteNavigation,
	useRepositoryActiveBranchId,
	useRepositoryDefaultBranchId,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import { ATELIER_BUILTIN_EXTENSION_IDS } from "@opral/atelier";
import { libraryFolderState } from "~/components/repository-home/host-extensions";

export const Route = createFileRoute("/@{$namespace}/$repository/folder/$")({
	head: ({ params, match }) => repositoryHead(params, "folder", match.search),
	beforeLoad: ({ params }) => {
		if (!parseEntityUrlSplat(params._splat)) notFound({ throw: true });
	},
	component: RepositoryFolderRoute,
});

/**
 * A folder URL drives the primary surface: the pinned Library tab opens the
 * named folder in Folders mode, in place. Folder tabs a user forked with
 * cmd-click keep their own state and claim the URL only while active.
 */
function RepositoryFolderRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const beginRouteNavigation = useBeginRepositoryRouteNavigation();
	const consumeShellNavigation = useConsumeShellEntityNavigation();
	const { _splat: dirSplat, namespace, repository } = Route.useParams();
	const entityId = parseEntityUrlSplat(dirSplat)?.id;
	const defaultBranchId = useRepositoryDefaultBranchId();
	const navigate = useNavigate();
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();
	const [resolvedEntity, setResolvedEntity] = useState<{
		atelier: typeof atelier;
		branchId: string | null;
		id: string;
		path: string;
	} | null>(null);

	// A descriptive path replacement is still the same folder navigation.
	// Keep it separate from the effect that owns the pending view command.
	useEffect(() => {
		if (
			!resolvedEntity ||
			resolvedEntity.atelier !== atelier ||
			resolvedEntity.branchId !== activeBranchId ||
			resolvedEntity.id !== entityId
		)
			return;
		const canonical = canonicalEntitySplat(dirSplat, resolvedEntity);
		if (!canonical) return;
		void navigate({
			to: "/@{$namespace}/$repository/folder/$",
			params: { namespace, repository, _splat: canonical },
			search: branch ? { branch } : {},
			replace: true,
		});
	}, [
		activeBranchId,
		atelier,
		branch,
		dirSplat,
		entityId,
		namespace,
		navigate,
		repository,
		resolvedEntity,
	]);

	useEffect(() => {
		if (!atelier || !entityId) return;
		if (activeBranchId !== (branch ?? defaultBranchId)) return;
		if (consumeShellNavigation(`directory:${entityId}`)) {
			markRouteSynced();
			return;
		}
		const controller = beginRouteNavigation();
		void readRepositoryRoute(controller.signal, () =>
			findLixEntity(atelier.lix, "directory", { id: entityId }),
		)
			.then((entity) => {
				if (controller.signal.aborted) return;
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
						if (!controller.signal.aborted && !settled && retriesLeft > 0) {
							attempt(retriesLeft - 1);
						}
					}, 800);
					atelier.views
						.open(ATELIER_BUILTIN_EXTENSION_IDS.library, {
							state: libraryFolderState(dirPath),
							signal: controller.signal,
						})
						.then(() => {
							settled = true;
							clearTimeout(timer);
							if (!controller.signal.aborted) {
								markRouteSynced();
								setResolvedEntity({
									atelier,
									branchId: activeBranchId,
									id: entityId,
									path: dirPath,
								});
							}
						})
						.catch((error: unknown) => {
							settled = true;
							clearTimeout(timer);
							if (controller.signal.aborted) return;
							const transient =
								error instanceof Error &&
								error.message.includes("shell unmounted");
							if (transient && retriesLeft > 0) {
								setTimeout(() => {
									if (!controller.signal.aborted) attempt(retriesLeft - 1);
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
				if (!controller.signal.aborted) {
					console.error("Unable to resolve directory", error);
					markRouteSynced();
				}
			});
		return () => {
			controller.abort();
		};
	}, [
		beginRouteNavigation,
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
