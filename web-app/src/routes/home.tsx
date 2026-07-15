import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceDirectory } from "~/components/workspace-directory";

export const Route = createFileRoute("/home")({
	head: () => ({
		meta: [{ title: "Home · LixRay" }, { name: "robots", content: "noindex" }],
	}),
	component: HomePage,
});

function HomePage() {
	return <WorkspaceDirectory />;
}
