export function RepositoryOpenFailure({
	message,
	storageBusy,
	onRetry,
}: {
	message: string;
	storageBusy: boolean;
	onRetry: () => void;
}) {
	return (
		<main className="absolute inset-0 grid place-content-center bg-bg p-6 text-center text-fg-muted">
			<div
				className="grid justify-items-center gap-2 [&_span]:max-w-[640px] [&_span]:text-fg-subtle"
				role="alert"
			>
				<strong>
					{storageBusy
						? "Repository is already open"
						: "Unable to open Atelier"}
				</strong>
				<span className="whitespace-pre-wrap break-words">
					{storageBusy
						? "Another tab or app window is using this repository. Close its other tabs and windows, then retry. Your saved local changes will be kept."
						: message}
				</span>
				{storageBusy ? (
					<button
						type="button"
						className="mt-2 rounded-md bg-fg px-4 py-2 text-bg focus-visible:outline-2 focus-visible:outline-offset-2"
						onClick={onRetry}
					>
						Retry
					</button>
				) : null}
			</div>
		</main>
	);
}
