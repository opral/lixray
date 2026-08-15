import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { SqlConsole } from "~/components/sql-console";
import { RepositoryGate } from "~/components/repository-gate";

export const Route = createFileRoute("/sql")({
	component: SqlPage,
});

function SqlPage() {
	return (
		<RepositoryGate>
			{(activeRepository) => (
				<AppShell key={activeRepository.repository.id}>
					<SqlConsole repositoryName={activeRepository.repository.name} />
				</AppShell>
			)}
		</RepositoryGate>
	);
}
