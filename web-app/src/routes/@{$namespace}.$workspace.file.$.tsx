import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWorkspaceAtelierInstance } from "~/components/workspace-atelier";

export const Route = createFileRoute("/@{$namespace}/$workspace/file/$")({
	component: WorkspaceFileRoute,
});

function WorkspaceFileRoute() {
	const atelier = useWorkspaceAtelierInstance();
	const { _splat: filePath } = Route.useParams();

	useEffect(() => {
		if (!atelier || !filePath) return;
		void atelier.file.open({ path: `/${filePath}` }).catch((error: unknown) => {
			console.error("Unable to open the requested Atelier file", error);
		});
	}, [atelier, filePath]);

	return null;
}
