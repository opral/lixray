/**
 * The file tools' pure parts: path rules, the SQL a write batch runs, and
 * how bytes travel as JSON. The service runs the SQL; the server registers
 * the tools. Everything here is what the SQL tools would have needed an
 * agent to know.
 */
import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";
import type { WireValue } from "./lix-service.ts";

export { base64ToBytes, bytesToBase64 };

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

/**
 * A file to write. Text and bytes are separate fields, because which one the
 * caller used is the encoding decision — there is nothing to infer later.
 */
export type FileWrite = {
	path: string;
	content?: string;
	content_base64?: string;
	/** Omitted keeps the file's metadata; an object replaces it; null clears it. */
	lixcol_metadata?: Record<string, unknown> | null;
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

/** The directories above a file, shallowest first, so each insert has its parent. */
export function parentDirectories(path: string): string[] {
	const segments = path.split("/").filter(Boolean);
	const parents: string[] = [];
	for (let depth = 1; depth < segments.length; depth += 1) {
		parents.push(`/${segments.slice(0, depth).join("/")}`);
	}
	return parents;
}

/** LIKE pattern escaping for user text, with `\` as the escape character. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const encoder = new TextEncoder();

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

/** The bytes a write carries, whichever field the caller used. */
export function writeBytes(file: FileWrite): Uint8Array | undefined {
	if (file.content !== undefined) return encoder.encode(file.content);
	if (file.content_base64 !== undefined)
		return base64ToBytes(file.content_base64);
	return undefined;
}

export type FileWriteStatement = {
	sql: string;
	params: WireValue[];
	/** The file this statement writes; directory inserts carry none. */
	path?: string;
};

/**
 * The batch one write_files call runs: every missing parent directory,
 * shallowest first, then one upsert per file. Text content is bound as
 * text and cast to bytes by Lix; binary content is bound as bytes.
 * Metadata rides in the same statement, so content and metadata land in
 * one commit. A metadata-only write updates the existing row.
 */
export function fileWriteStatements(
	files: readonly FileWrite[],
): FileWriteStatement[] {
	const statements: FileWriteStatement[] = [];
	const directories = new Set<string>();
	for (const file of files) {
		for (const directory of parentDirectories(file.path)) {
			if (directories.has(directory)) continue;
			directories.add(directory);
			statements.push({
				sql: "INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING",
				params: [{ kind: "text", value: directory }],
			});
		}
	}
	for (const file of files) {
		const metadata: WireValue | undefined =
			file.lixcol_metadata === undefined
				? undefined
				: file.lixcol_metadata === null
					? { kind: "null" }
					: { kind: "json", value: file.lixcol_metadata };
		if (file.content === undefined && file.content_base64 === undefined) {
			statements.push({
				sql: "UPDATE lix_file SET lixcol_metadata = $2 WHERE path = $1 RETURNING id, path",
				params: [
					{ kind: "text", value: file.path },
					metadata ?? { kind: "null" },
				],
				path: file.path,
			});
			continue;
		}
		// Which field the caller used says how to bind it; nothing is inferred
		// from the shape of a value here.
		const isText = file.content !== undefined;
		const contentParam: WireValue = isText
			? { kind: "text", value: file.content as string }
			: { kind: "blob", base64: file.content_base64 as string };
		const contentSql = isText ? "CAST($2 AS BYTEA)" : "$2";
		if (metadata === undefined) {
			statements.push({
				sql: `INSERT INTO lix_file (path, content) VALUES ($1, ${contentSql}) ON CONFLICT (path) DO UPDATE SET content = excluded.content RETURNING id, path`,
				params: [{ kind: "text", value: file.path }, contentParam],
				path: file.path,
			});
		} else {
			statements.push({
				sql: `INSERT INTO lix_file (path, content, lixcol_metadata) VALUES ($1, ${contentSql}, $3) ON CONFLICT (path) DO UPDATE SET content = excluded.content, lixcol_metadata = excluded.lixcol_metadata RETURNING id, path`,
				params: [{ kind: "text", value: file.path }, contentParam, metadata],
				path: file.path,
			});
		}
	}
	return statements;
}

/**
 * What changed between two commits, both sides included.
 *
 * A card is a function of a commit span, whatever produced the span — the
 * receipt of a write, a checkpoint, two commits someone pasted. Lix answers
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

/** The paths a diff over the target files reports as changed. */
export const CHANGED_FILES_SQL = (count: number): string => {
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 3}`,
	).join(", ");
	return `SELECT from_path, to_path FROM lix_diff('lix_file', $1, $2) WHERE from_path IN (${placeholders}) OR to_path IN (${placeholders})`;
};

export const READ_FILES_SQL = (count: number): string => {
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 1}`,
	).join(", ");
	return `SELECT id, path, content, lixcol_metadata FROM lix_file WHERE path IN (${placeholders})`;
};
