import type { RepositoryMigrationState } from "../lib/repository-lix-session";

export function RepositoryUpgradeProgress({
	phase,
}: {
	phase: RepositoryMigrationState["phase"];
}) {
	return (
		<main className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-bg-app p-6 text-center text-text-secondary">
			<strong role="status" aria-live="polite">
				{repositoryMigrationHeading(phase)}
			</strong>
			<span className="text-sm text-text-tertiary">
				Your repository is being updated automatically.
			</span>
			<div
				className="h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-border-subtle"
				role="progressbar"
				aria-label="Upgrading repository"
				aria-valuetext="Upgrade in progress"
			>
				<div className="h-full w-1/3 motion-safe:animate-pulse rounded-full bg-text-secondary" />
			</div>
		</main>
	);
}

function repositoryMigrationHeading(
	phase: RepositoryMigrationState["phase"],
): string {
	switch (phase) {
		case "validating":
			return "Verifying repository upgrade…";
		case "opening":
			return "Opening upgraded repository…";
		case "migrating":
		case undefined:
			return "Upgrading repository…";
	}
}
