import { readRepositoryRoute } from "~/lib/repository-route-lifecycle";
import {
	canonicalEntitySplat,
	parseEntityUrlSplat,
	resolveLixEntityForRoute,
} from "~/lib/entity-url";
import { EntityRoutePending } from "~/components/entity-route-pending";
import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { AtelierDocumentCommandNotCompletedError } from "@opral/atelier";
import { useEffect, useState } from "react";
import {
	useMarkRepositoryRouteSynced,
	useBeginRepositoryRouteNavigation,
	useConsumeShellEntityNavigation,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
	useRepositoryFileOpenTrace,
	useRepositoryDefaultBranchId,
	useRepositoryEntityRouteLookupPolicy,
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
	const lookupPolicy = useRepositoryEntityRouteLookupPolicy();
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
	const [pendingEntity, setPendingEntity] = useState<
		"waiting" | "retry" | null
	>(null);
	const [lookupRetry, setLookupRetry] = useState(0);

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
		let waitingForMetadata = false;
		setPendingEntity(null);
		void readRepositoryRoute(controller.signal, () => {
			const resolve = () =>
				resolveLixEntityForRoute(
					atelier.lix,
					"file",
					{ id: entityId },
					{
						policy: lookupPolicy,
						signal: controller.signal,
						onWaiting: () => {
							waitingForMetadata = true;
							setPendingEntity("waiting");
						},
					},
				);
			return fileOpenTrace ? fileOpenTrace.run(resolve) : resolve();
		})
			.then(async (resolution) => {
				if (controller.signal.aborted) return;
				waitingForMetadata = false;
				if (resolution.kind === "pending") {
					controller.abort();
					fileOpenTrace?.cancel();
					setPendingEntity("retry");
					return;
				}
				if (resolution.kind === "missing") throw new Error("Entity not found");
				setPendingEntity(null);
				const entity = resolution.entity;
				requestedPath = entity.path;
				fileOpenTrace?.resolved(entityId, requestedPath);
				const open = async (retriesLeft: number): Promise<void> => {
					controller.signal.throwIfAborted();
					try {
						await (fileOpenTrace
							? fileOpenTrace.run(() =>
									atelier.documents.open(requestedPath, {
										fileId: entityId,
										signal: controller.signal,
										navigationCause: "route",
									}),
								)
							: atelier.documents.open(requestedPath, {
									fileId: entityId,
									signal: controller.signal,
									navigationCause: "route",
								}));
					} catch (error) {
						if (
							!(error instanceof AtelierDocumentCommandNotCompletedError) ||
							retriesLeft === 0
						)
							throw error;
						await new Promise((resolve) => setTimeout(resolve, 150));
						await open(retriesLeft - 1);
					}
				};
				await open(3);
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
				if (waitingForMetadata && lookupPolicy === "partial_replica") {
					controller.abort();
					fileOpenTrace?.cancel();
					setPendingEntity("retry");
					console.error("Unable to resolve the requested Atelier file", error);
					return;
				}
				setPendingEntity(null);
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
		lookupPolicy,
		lookupRetry,
		consumeShellNavigation,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	if (!pendingEntity) return null;
	return (
		<EntityRoutePending
			kind="file"
			retryable={pendingEntity === "retry"}
			onRetry={() => setLookupRetry((attempt) => attempt + 1)}
			onReturnHome={() => {
				fileOpenTrace?.cancel();
				void navigate({
					to: "/@{$namespace}/$repository",
					params: { namespace, repository },
					search:
						branch && defaultBranchId
							? atelierBranchSearch(branch, defaultBranchId)
							: {},
				});
			}}
		/>
	);
}
