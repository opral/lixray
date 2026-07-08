export interface DroppedUpload {
	files: Array<{ relativePath: string; file: File }>;
	/** Relative paths (trailing slash) of dropped directories with no contents. */
	emptyDirPaths: Array<string>;
}

export async function collectDroppedItems(
	dataTransfer: DataTransfer,
): Promise<DroppedUpload> {
	// webkitGetAsEntry must be called synchronously on every item before the
	// first await — the DataTransferItemList is invalidated once the drop
	// event handler yields.
	const entries: Array<FileSystemEntry> = [];
	for (const item of Array.from(dataTransfer.items)) {
		if (item.kind !== "file") {
			continue;
		}
		const entry = item.webkitGetAsEntry();
		if (entry) {
			entries.push(entry);
		}
	}

	if (entries.length === 0) {
		return {
			files: Array.from(dataTransfer.files).map((file) => ({
				relativePath: file.name,
				file,
			})),
			emptyDirPaths: [],
		};
	}

	const result: DroppedUpload = { files: [], emptyDirPaths: [] };
	for (const entry of entries) {
		await traverse(entry, "", result);
	}
	return result;
}

async function traverse(
	entry: FileSystemEntry,
	prefix: string,
	result: DroppedUpload,
): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => {
			(entry as FileSystemFileEntry).file(resolve, reject);
		});
		result.files.push({ relativePath: `${prefix}${entry.name}`, file });
		return;
	}
	if (entry.isDirectory) {
		const dirPrefix = `${prefix}${entry.name}/`;
		const children = await readAllEntries(entry as FileSystemDirectoryEntry);
		if (children.length === 0) {
			result.emptyDirPaths.push(dirPrefix);
			return;
		}
		for (const child of children) {
			await traverse(child, dirPrefix, result);
		}
	}
}

async function readAllEntries(
	dir: FileSystemDirectoryEntry,
): Promise<Array<FileSystemEntry>> {
	const reader = dir.createReader();
	const all: Array<FileSystemEntry> = [];
	// readEntries returns at most ~100 entries per call; loop until exhausted.
	for (;;) {
		const batch = await new Promise<Array<FileSystemEntry>>((resolve, reject) => {
			reader.readEntries(resolve, reject);
		});
		if (batch.length === 0) {
			return all;
		}
		all.push(...batch);
	}
}
