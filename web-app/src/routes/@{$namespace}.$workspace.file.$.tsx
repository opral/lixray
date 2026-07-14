import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { useWorkspaceAtelierInstance } from "~/components/workspace-atelier";
import { isAtelierFileNotFoundError } from "~/lib/atelier-navigation";

const NO_BRANCH_SUBSCRIBE = () => () => undefined;
const NO_BRANCH_SNAPSHOT = () => null;

export const Route = createFileRoute("/@{$namespace}/$workspace/file/$")({
	component: WorkspaceFileRoute,
});

function WorkspaceFileRoute() {
	const atelier = useWorkspaceAtelierInstance();
	const navigate = useNavigate();
	const { namespace, workspace, _splat: filePath } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useSyncExternalStore(
		atelier?.branches.subscribe ?? NO_BRANCH_SUBSCRIBE,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
	);

	useEffect(() => {
		if (!atelier || !filePath) return;
		if (branch && activeBranchId !== branch) return;
		let cancelled = false;
		const requestedPath = `/${filePath}`;
		void atelier.documents.open(requestedPath).catch((error: unknown) => {
			if (!isAtelierFileNotFoundError(error, requestedPath)) {
				console.error("Unable to open the requested Atelier file", error);
				return;
			}
			if (cancelled) {
				return;
			}
			const routedBranch = branch ?? activeBranchId ?? undefined;
			void navigate({
				to: "/@{$namespace}/$workspace",
				params: { namespace, workspace },
				search: routedBranch ? { branch: routedBranch } : {},
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
		filePath,
		namespace,
		navigate,
		workspace,
	]);

	return null;
}
