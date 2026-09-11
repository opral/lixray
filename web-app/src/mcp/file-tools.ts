/**
 * The file tools' pure parts: path rules, the SQL a write batch runs, and
 * how bytes travel as JSON. The service runs the SQL; the server registers
 * the tools. Everything here is what the SQL tools would have needed an
 * agent to know.
 */
import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";
import type { WireValue } from "./lix-service.ts";

export { base64ToBytes, bytesToBase64 };

/** Bytes as JSON: text when UTF-8 says so, base64 otherwise. */
export type FileContent = { text: string } | { base64: string };

export type FileWrite = {
	path: string;
	content?: FileContent;
	/** Omitted keeps the file's metadata; an object replaces it; null clears it. */
	lixcol_metadata?: Record<string, unknown> | null;
};

/** Text is offered up to this many bytes; larger files travel as base64. */
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

/** How a file's bytes travel: UTF-8 text when they are that, else base64. */
export function encodeFileContent(bytes: Uint8Array): {
	content: FileContent;
	size: number;
} {
	const size = bytes.byteLength;
	if (size <= TEXT_CONTENT_LIMIT) {
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			return { content: { text }, size };
		} catch {
			// Not UTF-8: fall through to base64.
		}
	}
	return { content: { base64: bytesToBase64(bytes) }, size };
}

export function contentBytes(content: FileContent): Uint8Array {
	return "text" in content
		? encoder.encode(content.text)
		: base64ToBytes(content.base64);
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
		if (file.content === undefined) {
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
		const contentParam: WireValue =
			"text" in file.content
				? { kind: "text", value: file.content.text }
				: { kind: "blob", base64: file.content.base64 };
		const contentSql = "text" in file.content ? "CAST($2 AS BYTEA)" : "$2";
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
