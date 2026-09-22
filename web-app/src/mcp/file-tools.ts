/**
 * The read tools' pure parts: path rules, the SQL a read runs, and how
 * bytes become text. The service runs the SQL; the server registers the
 * tools. Writes are SQL: execute_sql is the one write path.
 */

/**
 * What a read says about a file it cannot hand over as text.
 *
 * The reason travels with the answer. A single union of text-or-base64 said
 * neither which of the two it was nor why, so every consumer re-derived it —
 * and a file over the ceiling was indistinguishable from a PNG.
 */
export type FileEncoding = "binary" | "too-large";

/**
 * A file's bytes as a read hands them over: text, or nothing and a reason.
 *
 * Base64 of an image is not something the reader asking for it can use — it
 * costs thousands of tokens and shows them nothing. Bytes are fetched
 * deliberately, through SQL, by a caller that wants bytes.
 */
export type FileRead = {
	size: number;
	/** The file's text. Absent exactly when `encoding` says why it is not here. */
	content?: string;
	/** Why there is no text. Absent exactly when `content` is present. */
	encoding?: FileEncoding;
};

/** Text is offered up to this many bytes; larger files are named, not sent. */
export const TEXT_CONTENT_LIMIT = 1024 * 1024;

const FILE_PATH = /^\/(?:[^/]+\/)*[^/]+$/;

/** An absolute path with no empty, `.`, or `..` segments. */
export function normalizeFilePath(input: string): string {
	const path = input.trim();
	if (
		!FILE_PATH.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new RangeError(
			`"${input}" is not an absolute file path such as /docs/notes.md`,
		);
	}
	return path;
}

/** LIKE pattern escaping for user text, with `\` as the escape character. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * A file's bytes as text, or the reason they are not on offer.
 *
 * The only decoder: everything downstream reads `content` or does not, rather
 * than deciding for itself what UTF-8 means. It is strict on purpose — a
 * lenient decode answers "is this text?" with "yes, always", and hands a CSV
 * grid a screen of replacement characters instead of refusing the file.
 */
export function readFileContent(bytes: Uint8Array): FileRead {
	const size = bytes.byteLength;
	if (size > TEXT_CONTENT_LIMIT) return { encoding: "too-large", size };
	try {
		return { content: decodeUtf8(bytes), size };
	} catch {
		return { encoding: "binary", size };
	}
}

/** Throws on anything that is not UTF-8, rather than mangling it. */
export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * What changed between two commits, both sides included.
 *
 * A card is a function of a commit span, whatever produced the span — the
 * receipt of a batch, a checkpoint, two commits someone pasted. Lix answers
 * this keyed to the commits, so nothing another writer does afterwards
 * changes the answer. With paths, only those files; without, every file.
 */
export const FILE_CHANGES_SQL = (count: number): string => {
	const select =
		"SELECT id, diff_type, from_path, to_path, from_content, to_content FROM lix_diff('lix_file', $1, $2)";
	if (count === 0) return select;
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 3}`,
	).join(", ");
	return `${select} WHERE from_path IN (${placeholders}) OR to_path IN (${placeholders})`;
};

export const READ_FILES_SQL = (count: number): string => {
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 1}`,
	).join(", ");
	return `SELECT id, path, content, lixcol_metadata FROM lix_file WHERE path IN (${placeholders})`;
};
