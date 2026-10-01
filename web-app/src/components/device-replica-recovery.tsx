import { useEffect, useRef, useState } from "react";
import {
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "../lib/repository-opfs-cache.ts";
import {
	currentReplicaStorage,
	retainedReplicaStorageNames as migrationSources,
} from "../lib/repository-migration.ts";
import {
	activeReplicaStorage,
	retainedReplicaStorageNames as replacementSources,
} from "../lib/repository-replica-replacement.ts";
import {
	discoverDeviceReplicaStorageNames,
	exportDeviceReplicaBackup,
} from "../lib/repository-device-backup.ts";

/** App-routed old stores are siblings, not native generations of the new store.
 * Recovery stays available even when the native engine cannot open an old format.
 */
export function DeviceReplicaRecovery({
	repositoryId,
	authIdentity,
	openingFailed,
}: {
	repositoryId: string;
	authIdentity: string;
	openingFailed: boolean;
}) {
	const [names, setNames] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<number | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		let active = true;
		const current = generation.current + 1;
		generation.current = current;
		setError(null);
		setNames([]);
		setBusy(null);
		void repositoryBrowserReplicaId({ repositoryId, authIdentity })
			.then(async (replicaId) => {
				const original = repositoryOpfsCacheName({ repositoryId, replicaId });
				try {
					const migrated = currentReplicaStorage(original);
					const current = activeReplicaStorage(migrated);
					const sources = [
						...new Set([
							...migrationSources(original),
							...replacementSources(migrated),
							...(openingFailed ? [current] : []),
						]),
					];
					if (active) setNames(sources);
				} catch {
					try {
						const discovered =
							await discoverDeviceReplicaStorageNames(original);
						if (active) {
							setNames(discovered);
							setError(
								"The saved-copy catalog is invalid. The copies listed here were found in this repository's OPFS namespace. Download each needed copy and contact support; no local copy was changed.",
							);
						}
					} catch (scanError) {
						if (active) {
							setNames([original]);
							const scanLimit =
								scanError instanceof Error &&
								scanError.message.startsWith(
									"The saved-copy directory exceeds the safe scan limit",
								);
							setError(
								scanLimit
									? `${scanError.message} Only the original copy can be listed safely; other copies may remain on this device.`
									: "The saved-copy catalog is invalid and its OPFS directory could not be scanned safely. Only the original copy can be listed here; other matching copies may remain on this device. Keep browser storage intact and contact support.",
							);
						}
					}
				}
			})
			.catch(() => {
				if (active)
					setError(
						"The saved-copy catalog could not be read. Browser storage has not been changed.",
					);
			});
		return () => {
			active = false;
			generation.current = current + 1;
		};
	}, [repositoryId, authIdentity, openingFailed]);
	if (!names.length && !error) return null;
	async function download(name: string, index: number) {
		const current = generation.current;
		setBusy(index);
		setError(null);
		try {
			const blob = await exportDeviceReplicaBackup(name);
			if (generation.current !== current) return;
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `lix-saved-device-copy-${index + 1}.zip`;
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (caught) {
			if (generation.current === current)
				setError(
					caught instanceof Error
						? caught.message
						: "The download failed. Saved changes remain on this device.",
				);
		} finally {
			if (generation.current === current) setBusy(null);
		}
	}
	return (
		<aside
			aria-label="Older device copies"
			className="absolute right-4 top-16 z-50 max-h-[60vh] max-w-sm overflow-auto rounded-lg border border-border-subtle bg-bg p-3 text-sm text-fg-muted shadow-lg"
		>
			<strong>Saved device copies</strong>
			<p className="mt-2">
				These copies remain on this device. Download preserves their data for
				recovery, including formats this release cannot open. It does not
				restore changes to the repository. Keep the archive private and contact
				support for recovery.
			</p>
			{names.map((name, index) => (
				<button
					className="mt-2 block"
					type="button"
					key={name}
					disabled={busy !== null}
					onClick={() => void download(name, index)}
				>
					{busy === index
						? "Preparing download…"
						: `Download saved copy ${index + 1}`}
				</button>
			))}
			{error ? (
				<p className="mt-2" role="alert">
					{error}
				</p>
			) : null}
		</aside>
	);
}
