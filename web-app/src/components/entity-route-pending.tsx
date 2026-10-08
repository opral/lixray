import type { EntityKind } from "~/lib/entity-url";

export function EntityRoutePending({
	kind,
	retryable,
	onRetry,
	onReturnHome,
}: {
	readonly kind: EntityKind;
	readonly retryable: boolean;
	readonly onRetry: () => void;
	readonly onReturnHome: () => void;
}) {
	const label = kind === "file" ? "file" : "folder";
	return (
		<div className="fixed inset-0 z-50 grid place-content-center bg-bg/90 p-8 text-center text-fg-muted">
			<section className="grid max-w-md justify-items-center gap-4">
				<p role="status" aria-live="polite">
					{retryable
						? `${label === "file" ? "File" : "Folder"} is still unavailable. Retry or return to the repository.`
						: `Waiting for ${label} to sync…`}
				</p>
				<div className="flex flex-wrap justify-center gap-3">
					{retryable ? (
						<button
							type="button"
							className="rounded-md border px-3 py-2 text-sm text-fg"
							onClick={onRetry}
						>
							Retry
						</button>
					) : null}
					<button
						type="button"
						className="rounded-md border px-3 py-2 text-sm text-fg"
						onClick={onReturnHome}
					>
						Return to repository
					</button>
				</div>
			</section>
		</div>
	);
}
