export const ZIP_DOWNLOAD_BATCH_SIZE = 50;

export interface ZipFileFetch {
	path: string;
	zipPath: string;
}

/**
 * Loads ZIP file contents in bounded path batches while preserving the caller's
 * requested ZIP entry order. Repeated source paths are fetched only once.
 */
export async function fetchZipEntriesInBatches(
	files: ReadonlyArray<ZipFileFetch>,
	fetchPaths: (paths: Array<string>) => Promise<Map<string, Uint8Array>>,
	batchSize = ZIP_DOWNLOAD_BATCH_SIZE,
): Promise<Record<string, Uint8Array>> {
	const entries: Record<string, Uint8Array> = {};
	const bytesByPath = new Map<string, Uint8Array>();

	for (let offset = 0; offset < files.length; offset += batchSize) {
		const batch = files.slice(offset, offset + batchSize);
		const paths = [
			...new Set(
				batch.map((file) => file.path).filter((path) => !bytesByPath.has(path)),
			),
		];
		if (paths.length > 0) {
			for (const [path, bytes] of await fetchPaths(paths)) {
				bytesByPath.set(path, bytes);
			}
		}

		for (const file of batch) {
			const bytes = bytesByPath.get(file.path);
			if (!bytes) throw new Error("File data not found.");
			entries[file.zipPath] = bytes;
		}
	}

	return entries;
}
