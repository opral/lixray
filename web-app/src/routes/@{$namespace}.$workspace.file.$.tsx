import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkWorkspaceRouteSynced,
	useWorkspaceActiveBranchId,
	useWorkspaceAtelierInstance,
	useWorkspaceDefaultBranchId,
} from "~/components/workspace-atelier";
import {
	atelierBranchSearch,
	isAtelierFileNotFoundError,
} from "~/lib/atelier-navigation";

export const Route = createFileRoute("/@{$namespace}/$workspace/file/$")({
	component: WorkspaceFileRoute,
});

function WorkspaceFileRoute() {
	const atelier = useWorkspaceAtelierInstance();
	const defaultBranchId = useWorkspaceDefaultBranchId();
	const markRouteSynced = useMarkWorkspaceRouteSynced();
	const navigate = useNavigate();
	const { namespace, workspace, _splat: filePath } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useWorkspaceActiveBranchId();

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
					to: "/@{$namespace}/$workspace",
					params: { namespace, workspace },
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
		workspace,
	]);

	return null;
}
