import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { PreviewUnavailable } from "~/components/preview-unavailable";
import { SqlConsole } from "~/components/sql-console";
import { WorkspaceGate } from "~/components/workspace-gate";
import { isPreviewMode } from "~/lib/e2e-client";

export const Route = createFileRoute("/sql")({
	component: SqlPage,
});

function SqlPage() {
	if (isPreviewMode) return <PreviewUnavailable feature="SQL console" />;
	return (
		<WorkspaceGate>
			{(activeWorkspace) => (
				<AppShell key={activeWorkspace.workspace.id}>
					<SqlConsole workspaceName={activeWorkspace.workspace.name} />
				</AppShell>
			)}
		</WorkspaceGate>
	);
}
