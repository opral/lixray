import { useEffect, useRef, useState } from "react";
import {
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "../lib/repository-opfs-cache.ts";
import { currentReplicaStorage } from "../lib/repository-migration.ts";
import { activeReplicaStorage } from "../lib/repository-replica-replacement.ts";
import { captureExceptionTelemetry } from "../lib/telemetry.ts";

/** Explicit fresh-server reset; the replacement protocol retains the old copy. */
export function DeviceReplicaRecovery({
	repositoryId,
	authIdentity,
	openingFailed,
	onReset,
	resetAvailable = true,
}: {
	repositoryId: string;
	authIdentity: string;
	openingFailed: boolean;
	resetAvailable?: boolean;
	onReset: (storageName: string, signal: AbortSignal) => Promise<string>;
}) {
	const [activeName, setActiveName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		const current = ++generation.current;
		setActiveName(null);
		setError(null);
		setBusy(false);
		if (openingFailed && resetAvailable) {
			void repositoryBrowserReplicaId({ repositoryId, authIdentity })
				.then((replicaId) => {
					const original = repositoryOpfsCacheName({ repositoryId, replicaId });
					const name = activeReplicaStorage(currentReplicaStorage(original));
					if (generation.current === current) setActiveName(name);
				})
				.catch((caught: unknown) => {
					captureExceptionTelemetry(caught, {
						operation: "repository_replica_reset_lookup",
						lix_id: repositoryId,
					});
					if (generation.current === current)
						setError(
							"Could not read this device copy. Try reloading the page.",
						);
				});
		}
		return () => {
			controller.current?.abort();
			generation.current = current + 1;
		};
	}, [repositoryId, authIdentity, openingFailed, resetAvailable]);
	async function reset() {
		if (!activeName || controller.current) return;
		const current = generation.current;
		const request = new AbortController();
		controller.current = request;
		setBusy(true);
		setError(null);
		try {
			await onReset(activeName, request.signal);
			if (generation.current === current) window.location.reload();
		} catch (caught) {
			if (!request.signal.aborted)
				captureExceptionTelemetry(caught, {
					operation: "repository_replica_reset",
					lix_id: repositoryId,
				});
			if (generation.current === current)
				setError(
					caught instanceof Error
						? caught.message
						: "Could not reset from server. Try again.",
				);
		} finally {
			if (generation.current === current) setBusy(false);
			if (controller.current === request) controller.current = null;
		}
	}
	if (!openingFailed || !resetAvailable) return null;
	return (
		<div className="mt-3 grid justify-items-center gap-2 text-sm">
			{activeName ? (
				<button
					type="button"
					className="rounded-md border border-border-subtle px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2"
					disabled={busy}
					onClick={() => void reset()}
				>
					{busy ? "Resetting…" : "Reset from server"}
				</button>
			) : null}
			{error ? (
				<p role="alert" className="max-w-lg break-words">
					{error}
				</p>
			) : null}
		</div>
	);
}
