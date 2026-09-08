import { repositoryHead } from "~/lib/page-head";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
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
	component: RepositoryFileRoute,
});

function RepositoryFileRoute() {
	const atelier = useRepositoryAtelierInstance();
	const defaultBranchId = useRepositoryDefaultBranchId();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const navigate = useNavigate();
	const { namespace, repository, _splat: filePath } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();

	useEffect(() => {
		if (!atelier || !filePath) return;
		if (branch && activeBranchId !== branch) return;
		let cancelled = false;
		const requestedPath = `/${filePath}`;
		void atelier.documents
			.open(requestedPath)
			.then(markRouteSynced)
			.catch((error: unknown) => {
				if (!isAtelierFileNotFoundError(error, requestedPath)) {
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
		filePath,
		markRouteSynced,
		namespace,
		navigate,
		repository,
	]);

	return null;
}
