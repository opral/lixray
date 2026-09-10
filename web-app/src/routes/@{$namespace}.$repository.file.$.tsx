import { findLixEntity, parseEntityUrlSplat } from "~/lib/entity-url";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
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
	head: ({ params }) => repositoryHead(params, "file"),
	beforeLoad: ({ params }) => {
		if (!parseEntityUrlSplat(params._splat)) notFound({ throw: true });
	},
	component: RepositoryFileRoute,
});

function RepositoryFileRoute() {
	const atelier = useRepositoryAtelierInstance();
	const defaultBranchId = useRepositoryDefaultBranchId();
	const markRouteSynced = useMarkRepositoryRouteSynced();
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
		let cancelled = false;
		let requestedPath = "";
		void findLixEntity(atelier.lix, "file", { id: entityId })
			.then(async (entity) => {
				if (cancelled) return;
				if (!entity) throw new Error("Entity not found");
				requestedPath = entity.path;
				await atelier.documents.open(requestedPath);
				if (!cancelled) markRouteSynced();
			})
			.catch((error: unknown) => {
				if (cancelled) return;
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
				if (cancelled) {
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
			cancelled = true;
		};
	}, [
		activeBranchId,
		atelier,
		branch,
		defaultBranchId,
		entityId,
		consumeShellNavigation,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	return null;
}
