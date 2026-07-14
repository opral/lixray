import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { useWorkspaceAtelierInstance } from "~/components/workspace-atelier";

const NO_BRANCH_SUBSCRIBE = () => () => undefined;
const NO_BRANCH_SNAPSHOT = () => null;

export const Route = createFileRoute("/@{$namespace}/$workspace/file/$")({
	component: WorkspaceFileRoute,
});

function WorkspaceFileRoute() {
	const atelier = useWorkspaceAtelierInstance();
	const { _splat: filePath } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useSyncExternalStore(
		atelier?.branches.subscribe ?? NO_BRANCH_SUBSCRIBE,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
	);

	useEffect(() => {
		if (!atelier || !filePath) return;
		if (branch && activeBranchId !== branch) return;
		void atelier.documents.open(`/${filePath}`).catch((error: unknown) => {
			console.error("Unable to open the requested Atelier file", error);
		});
	}, [activeBranchId, atelier, branch, filePath]);

	return null;
}
