import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	useMarkRepositoryRouteSynced,
	useRepositoryAtelierInstance,
} from "~/components/repository-atelier";
import { LIXRAY_PEOPLE_EXTENSION_ID } from "~/components/repository-home/host-extensions";

export const Route = createFileRoute("/@{$namespace}/$repository/team")({
	component: RepositoryTeamRoute,
});

/**
 * The People tab opened as a central content tab (3c). The URL names the
 * active tab, exactly like /file/ and /dir/; the tab itself is branch-
 * independent, so no branch gate is needed here.
 */
function RepositoryTeamRoute() {
	const atelier = useRepositoryAtelierInstance();
	const markRouteSynced = useMarkRepositoryRouteSynced();

	useEffect(() => {
		if (!atelier) return;
		void atelier.views
			.open(LIXRAY_PEOPLE_EXTENSION_ID)
			.catch((error: unknown) => {
				console.error("Unable to open the People tab", error);
			})
			// Synced even on failure: tab activations should drive the URL
			// again rather than staying frozen at a dead deep link.
			.finally(markRouteSynced);
	}, [atelier, markRouteSynced]);

	return null;
}
