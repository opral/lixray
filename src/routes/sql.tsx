import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { SqlConsole } from "~/components/sql-console";
import { WorkspaceGate } from "~/components/workspace-gate";

export const Route = createFileRoute("/sql")({
	component: SqlPage,
});

function SqlPage() {
	return (
		<WorkspaceGate>
			{(organizationName) => (
				<AppShell>
					<SqlConsole organizationName={organizationName} />
				</AppShell>
			)}
		</WorkspaceGate>
	);
}
