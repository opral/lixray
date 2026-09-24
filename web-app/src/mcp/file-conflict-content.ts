/**
 * Content included in an optimistic-write conflict response. This does not
 * serve file reads: ordinary reads go through bounded query_sql expressions.
 */
export type FileEncoding = "binary" | "too-large";

export type FileRead = {
	size: number;
	content?: string;
	encoding?: FileEncoding;
};

export const TEXT_CONTENT_LIMIT = 1024 * 1024;

/** Keep conflict details bounded and avoid decoding non-UTF-8 file bytes. */
export function readFileContent(bytes: Uint8Array): FileRead {
	const size = bytes.byteLength;
	if (size > TEXT_CONTENT_LIMIT) return { encoding: "too-large", size };
	try {
		return { content: decodeUtf8(bytes), size };
	} catch {
		return { encoding: "binary", size };
	}
}

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
