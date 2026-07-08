import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { FileExplorer } from "~/components/file-explorer/file-explorer";
import { WorkspaceGate } from "~/components/workspace-gate";
import { normalizeDirPath } from "~/lib/file-explorer-api";

export const Route = createFileRoute("/")({
	validateSearch: (search: Record<string, unknown>): { dir?: string } => {
		const dir = normalizeDirPath(search.dir);
		return dir === "/" ? {} : { dir };
	},
	component: DashboardPage,
});

function DashboardPage() {
	return (
		<WorkspaceGate>
			{(organizationName) => (
				<AppShell>
					<FileExplorer organizationName={organizationName} />
				</AppShell>
			)}
		</WorkspaceGate>
	);
}
