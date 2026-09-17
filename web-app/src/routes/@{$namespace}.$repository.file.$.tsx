import { readRepositoryRoute } from "~/lib/repository-route-lifecycle";
import {
	canonicalEntitySplat,
	findLixEntity,
	parseEntityUrlSplat,
} from "~/lib/entity-url";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
	useBeginRepositoryRouteNavigation,
	useConsumeShellEntityNavigation,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
	useRepositoryDefaultBranchId,
} from "~/components/repository-atelier";
import {
	atelierBranchSearch,
	isAtelierFileNotFoundError,
} from "~/lib/atelier-navigation";

export const Route = createFileRoute("/@{$namespace}/$repository/file/$")({
	head: ({ params, match }) => repositoryHead(params, "file", match.search),
	beforeLoad: ({ params }) => {
		if (!parseEntityUrlSplat(params._splat)) notFound({ throw: true });
	},
	component: RepositoryFileRoute,
});

function RepositoryFileRoute() {
	const atelier = useRepositoryAtelierInstance();
	const defaultBranchId = useRepositoryDefaultBranchId();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const beginRouteNavigation = useBeginRepositoryRouteNavigation();
	const consumeShellNavigation = useConsumeShellEntityNavigation();
	const navigate = useNavigate();
	const { namespace, repository, _splat: filePath } = Route.useParams();
	const entityId = parseEntityUrlSplat(filePath)?.id;
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();

	useEffect(() => {
		if (!atelier || !entityId) return;
		if (activeBranchId !== (branch ?? defaultBranchId)) return;
		if (consumeShellNavigation(`file:${entityId}`)) {
			markRouteSynced();
			return;
		}
		const controller = beginRouteNavigation();
		let requestedPath = "";
		void readRepositoryRoute(controller.signal, () =>
			findLixEntity(atelier.lix, "file", { id: entityId }),
		)
			.then(async (entity) => {
				if (controller.signal.aborted) return;
				if (!entity) throw new Error("Entity not found");
				requestedPath = entity.path;
				// The id resolved; the path in the URL is decoration. Write the
				// file's own path back over whatever the link claimed — a bare
				// id, a stale name, a typo.
				const canonical = canonicalEntitySplat(filePath, entity);
				if (canonical)
					void navigate({
						to: "/@{$namespace}/$repository/file/$",
						params: { namespace, repository, _splat: canonical },
						search:
							branch && defaultBranchId
								? atelierBranchSearch(branch, defaultBranchId)
								: {},
						replace: true,
					});
				await atelier.documents.open(requestedPath, {
					signal: controller.signal,
				});
				if (!controller.signal.aborted) markRouteSynced();
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				if (
					!(error instanceof Error && error.message === "Entity not found") &&
					!isAtelierFileNotFoundError(error, requestedPath)
				) {
					console.error("Unable to open the requested Atelier file", error);
					// Synced even on failure: tab activations should drive the
					// URL again rather than staying frozen at a dead deep link.
					markRouteSynced();
					return;
				}
				if (controller.signal.aborted) {
					return;
				}
				const routedBranch = branch ?? activeBranchId ?? undefined;
				void navigate({
					to: "/@{$namespace}/$repository",
					params: { namespace, repository },
					search:
						routedBranch && defaultBranchId
							? atelierBranchSearch(routedBranch, defaultBranchId)
							: {},
					replace: true,
				});
			});
		return () => {
			controller.abort();
		};
	}, [
		beginRouteNavigation,
		activeBranchId,
		atelier,
		branch,
		defaultBranchId,
		entityId,
		filePath,
		consumeShellNavigation,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	return null;
}
