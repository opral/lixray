import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import {
	useMarkWorkspaceRouteSynced,
	useWorkspaceAtelierInstance,
} from "~/components/workspace-atelier";
import {
	LIXRAY_DIR_EXTENSION_ID,
	lixrayDirInstanceKey,
	lixrayDirViewState,
} from "~/components/workspace-home/host-extensions";

const NO_BRANCH_SUBSCRIBE = () => () => undefined;
const NO_BRANCH_SNAPSHOT = () => null;

export const Route = createFileRoute("/@{$namespace}/$workspace/dir/$")({
	component: WorkspaceDirRoute,
});

/**
 * A folder opened as a central content tab (rule 3 of the tab model: the URL
 * names the active tab's location; opening navigates the tab in place).
 */
function WorkspaceDirRoute() {
	const atelier = useWorkspaceAtelierInstance();
	const markRouteSynced = useMarkWorkspaceRouteSynced();
	const { _splat: dirSplat } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useSyncExternalStore(
		atelier?.branches.subscribe ?? NO_BRANCH_SUBSCRIBE,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
		atelier?.branches.activeId ?? NO_BRANCH_SNAPSHOT,
	);

	useEffect(() => {
		if (!atelier || !dirSplat) return;
		if (branch && activeBranchId !== branch) return;
		const dirPath = `/${dirSplat}/`;
		void atelier.views
			.open(LIXRAY_DIR_EXTENSION_ID, {
				state: lixrayDirViewState(dirPath),
				instanceKey: lixrayDirInstanceKey(dirPath),
			})
			.then(markRouteSynced)
			.catch((error: unknown) => {
				console.error("Unable to open the requested workspace folder", error);
			});
	}, [activeBranchId, atelier, branch, dirSplat, markRouteSynced]);

	return null;
}
