import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
	useRepositoryActiveBranchId,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import {
	LIXRAY_DIR_EXTENSION_ID,
	lixrayDirInstanceId,
	lixrayDirViewState,
} from "~/components/repository-home/host-extensions";

export const Route = createFileRoute("/@{$namespace}/$repository/dir/$")({
	component: RepositoryDirRoute,
});

/**
 * A folder opened as a central content tab (rule 3 of the tab model: the URL
 * names the active tab's location; opening navigates the tab in place).
 */
function RepositoryDirRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();
	const { _splat: dirSplat } = Route.useParams();
	const { branch } = Route.useSearch();
	const activeBranchId = useRepositoryActiveBranchId();

	useEffect(() => {
		if (!atelier || !dirSplat) return;
		if (branch && activeBranchId !== branch) return;
		// Keep the exact directory-surface path supplied by the URL. The route
		// generator may include the trailing slash in the splat already.
		const dirPath = dirSplat.endsWith("/") ? `/${dirSplat}` : `/${dirSplat}/`;
		void atelier.views
			.open(LIXRAY_DIR_EXTENSION_ID, {
				state: lixrayDirViewState(dirPath),
				instanceId: lixrayDirInstanceId(dirPath),
			})
			.catch((error: unknown) => {
				console.error("Unable to open the requested repository folder", error);
			})
			// Synced even on failure: tab activations should drive the URL
			// again rather than staying frozen at a dead deep link.
			.finally(markRouteSynced);
	}, [activeBranchId, atelier, branch, dirSplat, markRouteSynced]);

	return null;
}
