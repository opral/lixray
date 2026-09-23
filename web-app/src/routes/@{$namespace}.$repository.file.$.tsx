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
	useMarkRepositoryRouteSynced,
	useBeginRepositoryRouteNavigation,
	useConsumeShellEntityNavigation,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
	useRepositoryFileOpenTrace,
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
	const fileOpenTrace = useRepositoryFileOpenTrace();
	const defaultBranchId = useRepositoryDefaultBranchId();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const beginRouteNavigation = useBeginRepositoryRouteNavigation();
	const consumeShellNavigation = useConsumeShellEntityNavigation();
	const navigate = useNavigate();
	const { namespace, repository, _splat: filePath } = Route.useParams();
	const entityId = parseEntityUrlSplat(filePath)?.id;
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();
	const [resolvedEntity, setResolvedEntity] = useState<{
		atelier: typeof atelier;
		branchId: string | null;
		id: string;
		path: string;
	} | null>(null);

	// The URL path is descriptive. Rewriting it must not restart (and abort)
	// the open command for the same stable file ID.
	useEffect(() => {
		if (
			!resolvedEntity ||
			resolvedEntity.atelier !== atelier ||
			resolvedEntity.branchId !== activeBranchId ||
			resolvedEntity.id !== entityId
		)
			return;
		const canonical = canonicalEntitySplat(filePath, resolvedEntity);
		if (!canonical) return;
		void navigate({
			to: "/@{$namespace}/$repository/file/$",
			params: { namespace, repository, _splat: canonical },
			search:
				branch && defaultBranchId
					? atelierBranchSearch(branch, defaultBranchId)
					: {},
			replace: true,
		});
	}, [
		activeBranchId,
		atelier,
		branch,
		defaultBranchId,
		entityId,
		filePath,
		namespace,
		navigate,
		repository,
		resolvedEntity,
	]);

	useEffect(() => {
		if (!atelier || !entityId) return;
		if (activeBranchId !== (branch ?? defaultBranchId)) return;
		if (consumeShellNavigation(`file:${entityId}`)) {
			markRouteSynced();
			return;
		}
		const controller = beginRouteNavigation();
		fileOpenTrace?.ensureRoute(entityId);
		let requestedPath = "";
		void readRepositoryRoute(controller.signal, () =>
			fileOpenTrace
				? fileOpenTrace.run(() =>
						findLixEntity(atelier.lix, "file", { id: entityId }),
					)
				: findLixEntity(atelier.lix, "file", { id: entityId }),
		)
			.then(async (entity) => {
				if (controller.signal.aborted) return;
				if (!entity) throw new Error("Entity not found");
				requestedPath = entity.path;
				fileOpenTrace?.resolved(entityId, requestedPath);
				await (fileOpenTrace
					? fileOpenTrace.run(() =>
							atelier.documents.open(requestedPath, {
								signal: controller.signal,
								navigationCause: "route",
							}),
						)
					: atelier.documents.open(requestedPath, {
							signal: controller.signal,
							navigationCause: "route",
						}));
				if (!controller.signal.aborted) {
					markRouteSynced();
					setResolvedEntity({
						atelier,
						branchId: activeBranchId,
						id: entityId,
						path: requestedPath,
					});
				}
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				// Atelier clears onReady when its workspace unmounts and supplies a
				// new handle when it remounts. This handle has been disposed, so a
				// retry on it would fail again. Leave the route pending; the new
				// handle reruns this effect and opens the deep link.
				if (
					error instanceof Error &&
					error.name === "AbortError" &&
					error.message === "Atelier workspace unmounted"
				)
					return;
				fileOpenTrace?.failed(entityId);
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
		fileOpenTrace,
		consumeShellNavigation,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	return null;
}
