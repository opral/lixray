import { strToU8, Zip, ZipPassThrough } from "fflate";

// Physical backup deliberately does not open/migrate a Lix or interpret its
// journal codecs. These coordinates match the pinned OPFS storage provider.
export const OPFS_BACKUP_DIRECTORY = ["lix", "sqlite-sahpool"];
export const OPFS_BACKUP_LOCK_PREFIXES = [
	"lix:opfs-owner:rpc-v4:",
	"lix:opfs-sqlite:",
];
// ZIP output remains in a Blob until download; bound it for mobile browsers.
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_SCAN_ENTRIES = 4096;

export function opfsBackupName(name: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(name)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function decodeOpfsBackupName(name: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/u.test(name) || name.length % 4 === 1)
		return undefined;
	try {
		const standard = name.replaceAll("-", "+").replaceAll("_", "/");
		const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
		const bytes = Uint8Array.from(atob(padded), (character) =>
			character.charCodeAt(0),
		);
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return opfsBackupName(decoded) === name ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function isRecoveryStorageNameForSource(name: string, source: string): boolean {
	if (name === source) return true;
	if (!name.startsWith(`${source}:`)) return false;
	let suffix = name.slice(source.length + 1);
	if (suffix.startsWith("format81:")) {
		suffix = suffix.slice("format81:".length);
		const replacementStart = suffix.indexOf(":replacement:");
		const formatSuffix =
			replacementStart === -1 ? suffix : suffix.slice(0, replacementStart);
		if (!isStorageNameSuffix(formatSuffix)) return false;
		if (replacementStart === -1) return true;
		suffix = suffix.slice(replacementStart + 1);
	}
	return (
		suffix.startsWith("replacement:") &&
		isStorageNameSuffix(suffix.slice("replacement:".length))
	);
}

function isStorageNameSegment(value: string): boolean {
	return (
		value.length > 0 &&
		value !== "." &&
		value !== ".." &&
		!/[\\/]/u.test(value) &&
		!value.includes("\u0000")
	);
}

function isStorageNameSuffix(value: string): boolean {
	return value.split(":").every(isStorageNameSegment);
}

type BackupDirectory = {
	getDirectoryHandle(name: string): Promise<BackupDirectory>;
	values(): AsyncIterable<BackupFile | BackupDirectoryEntry>;
};
type BackupFile = {
	kind: "file";
	name: string;
	getFile(): Promise<Blob>;
};
type BackupDirectoryEntry = BackupDirectory & {
	kind: "directory";
	name: string;
};

export interface DeviceBackupEnvironment {
	locks: Pick<LockManager, "request">;
	getDirectory(): Promise<BackupDirectory>;
}

/**
 * Find only this repository's original, format-81, and replacement stores.
 * This is a read-only provider-directory listing; it never opens a candidate
 * store. Returned names are subsequently backed up under their own provider
 * locks by `exportDeviceReplicaBackup`.
 */
export async function discoverDeviceReplicaStorageNames(
	originalStorageName: string,
	environment: Pick<DeviceBackupEnvironment, "getDirectory"> = {
		getDirectory: () =>
			navigator.storage.getDirectory() as unknown as Promise<BackupDirectory>,
	},
): Promise<string[]> {
	if (!originalStorageName.startsWith("lixray:local-first-v1:"))
		throw new Error("This saved copy is not a repository replica.");
	let directory = await environment.getDirectory();
	for (const segment of OPFS_BACKUP_DIRECTORY)
		directory = await directory.getDirectoryHandle(segment);

	const discovered = new Set<string>([originalStorageName]);
	let entryCount = 0;
	for await (const entry of directory.values()) {
		entryCount += 1;
		if (entryCount > MAX_RECOVERY_SCAN_ENTRIES)
			throw new Error(
				`The saved-copy directory exceeds the safe scan limit of ${MAX_RECOVERY_SCAN_ENTRIES} entries. The original copy remains available; contact support before changing browser storage.`,
			);
		if (entry.kind !== "directory") continue;
		const storageName = decodeOpfsBackupName(entry.name);
		if (
			storageName &&
			isRecoveryStorageNameForSource(storageName, originalStorageName)
		)
			discovered.add(storageName);
	}
	return [
		originalStorageName,
		...Array.from(discovered)
			.filter((name) => name !== originalStorageName)
			.sort(),
	];
}

/** Export an idle retained physical store without changing any source bytes.
 * Both provider fences are held until every file has been copied. An active
 * owner is rejected immediately, including old deployments using the RPC fence.
 */
export async function exportDeviceReplicaBackup(
	storageName: string,
	environment: DeviceBackupEnvironment = {
		locks: navigator.locks,
		getDirectory: () =>
			navigator.storage.getDirectory() as unknown as Promise<BackupDirectory>,
	},
): Promise<Blob> {
	if (!storageName.startsWith("lixray:local-first-v1:"))
		throw new Error("This saved copy is not a repository replica.");
	const withFence = <T>(prefix: string, callback: () => Promise<T>) =>
		environment.locks.request(
			`${prefix}${storageName}`,
			{ mode: "exclusive", ifAvailable: true },
			async (lock) => {
				if (!lock)
					throw new Error(
						"Close other LixRay tabs using this saved copy, then retry the download. Saved changes are preserved.",
					);
				return callback();
			},
		);
	return withFence(OPFS_BACKUP_LOCK_PREFIXES[0]!, () =>
		withFence(OPFS_BACKUP_LOCK_PREFIXES[1]!, async () => {
			let directory = await environment.getDirectory();
			for (const segment of [
				...OPFS_BACKUP_DIRECTORY,
				opfsBackupName(storageName),
			])
				directory = await directory.getDirectoryHandle(segment);
			const parts: Blob[] = [];
			let zipError: Error | undefined;
			let completed = false;
			const archive = new Zip((error, data, final) => {
				if (error) zipError = error;
				else parts.push(new Blob([new Uint8Array(data)]));
				if (final) completed = true;
			});
			let fileCount = 0;
			let bytes = 0;
			async function visit(current: BackupDirectory, prefix: string) {
				for await (const entry of current.values()) {
					if (
						!entry.name ||
						entry.name === "." ||
						entry.name === ".." ||
						/[\\/]/u.test(entry.name)
					)
						throw new Error("Invalid saved-copy file name.");
					const name = `${prefix}${entry.name}`;
					if (entry.kind === "directory") await visit(entry, `${name}/`);
					else {
						const file = await entry.getFile();
						bytes += file.size;
						if (bytes > MAX_BACKUP_BYTES)
							throw new Error(
								"This copy exceeds the browser download limit. It remains preserved on this device; contact support for a larger backup.",
							);
						const zipEntry = new ZipPassThrough(`opfs/${name}`);
						archive.add(zipEntry);
						const reader = file.stream().getReader();
						try {
							for (;;) {
								const chunk = await reader.read();
								if (chunk.done) break;
								zipEntry.push(chunk.value, false);
								if (zipError) throw zipError;
							}
							zipEntry.push(new Uint8Array(), true);
							fileCount++;
						} finally {
							reader.releaseLock();
						}
					}
				}
			}
			await visit(directory, "");
			if (fileCount === 0)
				throw new Error("The saved copy contains no physical files.");
			const manifest = new ZipPassThrough("manifest.json");
			archive.add(manifest);
			manifest.push(
				strToU8(
					JSON.stringify({
						version: 1,
						kind: "lixray-opfs-physical-recovery",
						storageName,
						provider: "sqlite-sahpool",
						capturedAt: new Date().toISOString(),
						bytes,
						note: "Preserved device data, including journal bytes, independent of Lix format codecs. This archive does not restore or publish changes. Restore only into an isolated compatible recovery environment; never overwrite the active repository.",
					}),
				),
				true,
			);
			archive.end();
			if (zipError) throw zipError;
			if (!completed) throw new Error("The saved-copy archive did not finish.");
			return new Blob(parts, { type: "application/zip" });
		}),
	);
}

export interface DeviceStorageState {
	persistent: boolean | null;
	pressure: boolean;
}

export async function inspectDeviceStorage(
	storage: Pick<StorageManager, "persisted" | "estimate"> = navigator.storage,
): Promise<DeviceStorageState> {
	const [persistence, estimate] = await Promise.allSettled([
		storage.persisted(),
		storage.estimate(),
	]);
	const usage =
		estimate.status === "fulfilled" ? estimate.value.usage : undefined;
	const quota =
		estimate.status === "fulfilled" ? estimate.value.quota : undefined;
	return {
		persistent: persistence.status === "fulfilled" ? persistence.value : null,
		pressure:
			typeof usage === "number" &&
			Number.isFinite(usage) &&
			usage >= 0 &&
			typeof quota === "number" &&
			Number.isFinite(quota) &&
			quota > 0 &&
			usage / quota >= 0.8,
	};
}
