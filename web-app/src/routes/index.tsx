import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceDirectory } from "~/components/workspace-directory";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	return <WorkspaceDirectory />;
}
