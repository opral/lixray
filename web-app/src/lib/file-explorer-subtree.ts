import type {
	ExecuteBatchRequest,
	ExecuteResponse,
	WireValue,
} from "./lixray-api";

export interface SubtreeEntries {
	directoryPaths: Array<string>;
	files: Array<{ id: string; path: string }>;
}

export function subtreeListStatements(
	dirPath: string,
): ExecuteBatchRequest["statements"] {
	// Lexicographic prefix range: directory paths end in "/" (0x2F), so the
	// exclusive upper bound replaces it with "0" (0x30).
	const upperBound = `${dirPath.slice(0, -1)}0`;
	const params = [text(dirPath), text(upperBound)];
	return [
		{
			sql: "SELECT path FROM lix_directory WHERE path >= $1 AND path < $2 ORDER BY path",
			params,
		},
		{
			sql: "SELECT id, path FROM lix_file WHERE path >= $1 AND path < $2 ORDER BY path",
			params,
		},
	];
}

export function parseSubtreeListResults(
	results: Array<ExecuteResponse>,
): SubtreeEntries {
	if (results.length !== 2 || !results[0] || !results[1]) {
		throw new Error("Subtree listing did not return both result sets.");
	}
	return {
		directoryPaths: results[0].rows.map((row) => asText(row[0])),
		files: results[1].rows.map((row) => ({
			id: asText(row[0]),
			path: asText(row[1]),
		})),
	};
}

export function parseSubtreeListBatchResults(
	results: Array<ExecuteResponse>,
	directoryCount: number,
): Array<SubtreeEntries> {
	if (results.length !== directoryCount * 2) {
		throw new Error("Subtree listing did not return every result set.");
	}
	return Array.from({ length: directoryCount }, (_, index) =>
		parseSubtreeListResults(results.slice(index * 2, index * 2 + 2)),
	);
}

function text(value: string): WireValue {
	return { kind: "text", value };
}

function asText(value: WireValue | undefined): string {
	if (!value || value.kind !== "text") {
		throw new Error("Expected a text value in the query result.");
	}
	return value.value;
}
