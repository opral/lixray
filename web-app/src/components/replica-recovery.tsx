import type {
	Lix,
	ReplicaRecoveryReceipt,
	ReplicaRecoverySource,
} from "@lix-js/sdk";
import { useEffect, useRef, useState } from "react";

/** Recovery is independent of opening the current server-backed repository. */
export function ReplicaRecovery({
	lix,
	onReviewBranch,
}: {
	lix: Lix;
	onReviewBranch: (branchId: string) => void;
}) {
	const currentLix = useRef<Lix | null>(lix);
	const [sources, setSources] = useState<ReplicaRecoverySource[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [expanded, setExpanded] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [results, setResults] = useState<
		Record<string, ReplicaRecoveryReceipt>
	>({});

	useEffect(() => {
		let active = true;
		currentLix.current = lix;
		setError(null);
		setSources([]);
		setResults({});
		setBusy(null);
		void lix.replicaRecoverySources().then(
			(value) => {
				if (active)
					setSources(value.filter((source) => source.recoveryRequired));
			},
			(caught: unknown) => {
				if (active) setError(errorMessage(caught));
			},
		);
		return () => {
			active = false;
			if (currentLix.current === lix) currentLix.current = null;
		};
	}, [lix, attempt]);

	if (sources.length === 0 && !error) return null;

	async function recover(source: ReplicaRecoverySource) {
		setBusy(source.id);
		setError(null);
		try {
			const result = await lix.recoverReplica(source.id);
			if (currentLix.current !== lix) return;
			setResults((previous) => ({ ...previous, [source.id]: result }));
		} catch (caught) {
			if (currentLix.current === lix) setError(errorMessage(caught));
		} finally {
			if (currentLix.current === lix) setBusy(null);
		}
	}

	async function download(source: ReplicaRecoverySource) {
		setBusy(source.id);
		setError(null);
		try {
			const bundle = await lix.exportReplicaRecovery(source.id);
			if (currentLix.current !== lix) return;
			const url = URL.createObjectURL(
				new Blob([JSON.stringify(bundle)], { type: "application/json" }),
			);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `lix-recovery-${source.repositoryId}-${source.id}.json`;
			anchor.click();
			// Keep the blob alive until the browser has started the download.
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (caught) {
			if (currentLix.current === lix) setError(errorMessage(caught));
		} finally {
			if (currentLix.current === lix) setBusy(null);
		}
	}

	return (
		<aside
			aria-label="Saved device changes"
			className="absolute bottom-4 left-4 z-50 max-h-[70vh] w-[min(26rem,calc(100%_-_2rem))] overflow-auto rounded-lg border border-border-subtle bg-bg-app p-4 text-sm text-text-secondary shadow-lg"
		>
			<div className="flex items-center justify-between gap-4">
				<strong>Saved device changes</strong>
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
				>
					{expanded ? "Minimize" : "Review"}
				</button>
			</div>
			{expanded ? (
				<div className="mt-3 grid gap-3">
					<p>
						Your repository is open. Changes from an older local copy may still
						need recovery. That copy is preserved on this device. Downloads
						contain the available recovery data and describe anything that could
						not be recovered.
					</p>
					{error ? (
						<div role="alert" className="grid gap-2">
							<p className="break-words">
								Could not complete recovery: {error}
							</p>
							{sources.length === 0 ? (
								<button
									type="button"
									onClick={() => setAttempt((value) => value + 1)}
								>
									Check again
								</button>
							) : null}
						</div>
					) : null}
					{sources.map((source, index) => {
						const result = results[source.id];
						return (
							<section
								key={source.id}
								className="grid gap-2 border-t border-border-subtle pt-3"
							>
								<strong>Saved copy {index + 1}</strong>
								<div className="flex flex-wrap gap-3">
									<button
										type="button"
										disabled={busy !== null}
										onClick={() => void recover(source)}
									>
										{busy === source.id
											? "Working…"
											: "Restore to recovery branches"}
									</button>
									<button
										type="button"
										disabled={busy !== null}
										onClick={() => void download(source)}
									>
										Download recovery data
									</button>
								</div>
								{result ? (
									<div className="grid gap-2" role="status">
										<p>
											{result.branchIds.length > 0
												? "Recovery branches are ready for review."
												: "No recovery branch was created."}{" "}
											The original saved copy is still retained.
										</p>
										{result.branchIds.map((branchId, branchIndex) => (
											<button
												key={branchId}
												type="button"
												onClick={() => onReviewBranch(branchId)}
											>
												Review recovery branch {branchIndex + 1}
											</button>
										))}
										{result.unresolved.length > 0 ? (
											<details>
												<summary>
													Some saved content still needs recovery
												</summary>
												<ul className="list-disc space-y-1 pl-5">
													{result.unresolved.map((message, itemIndex) => (
														<li key={itemIndex}>{message}</li>
													))}
												</ul>
											</details>
										) : null}
									</div>
								) : null}
							</section>
						);
					})}
				</div>
			) : null}
		</aside>
	);
}

function errorMessage(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
