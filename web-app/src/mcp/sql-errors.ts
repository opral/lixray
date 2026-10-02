import type { WireValue } from "./lix-service.ts";

export const SQL_TEXT_WRITE_RECIPE =
	'For text files use UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE path = $2 with two kind: "text" parameters (content, path). REPLACE, CONCAT and || can be used inside the BYTEA cast. Use one SQL statement per statements[] entry; use an explicit ON CONFLICT (path) target.';

/** Text bound straight into the byte column, in any of Lix's phrasings. */
const BINARY_CONTENT_PATTERN =
	/lix_file(?:\.content| fast write column 'content') expects (?:binary|blob) content/;
export const BINARY_CONTENT_HINT =
	"Bind text as CAST($n AS BYTEA) with a text param.";
export const NAMESPACE_CONFLICT_HINT =
	"The destination exists; pick another path or delete it first in the same batch.";

const NAMESPACE_CONFLICT_PATTERN =
	/filesystem namespace conflict: parent "([^"]+)" already contains (file|directory) entry "([^"]+)"/;

export type NamespaceConflict = {
	/** A directory id, or `<root>`. */
	parentId: string;
	kind: "file" | "directory";
	name: string;
};

/** Lix's namespace conflict, which names the parent by id, not path. */
export function parseNamespaceConflict(
	message: string,
): NamespaceConflict | undefined {
	const match = NAMESPACE_CONFLICT_PATTERN.exec(message);
	if (!match) return undefined;
	return {
		parentId: match[1]!,
		kind: match[2] as "file" | "directory",
		name: match[3]!,
	};
}

/**
 * The statement parameter that names the destination, when the parent
 * cannot be looked up: the first absolute path ending in the entry's name.
 * SET and VALUES come before WHERE, so the new path precedes the old one.
 */
export function destinationFromParams(
	params: ReadonlyArray<WireValue>,
	name: string,
): string | undefined {
	for (const param of params) {
		if (
			param.kind === "text" &&
			param.value.startsWith("/") &&
			param.value.replace(/\/+$/, "").endsWith(`/${name}`)
		)
			return param.value.replace(/\/+$/, "");
	}
	return undefined;
}

/** The conflict in the caller's terms: the path that is already taken. */
export function namespaceConflictMessage(
	conflict: NamespaceConflict,
	destination: string | undefined,
): { message: string; hint: string } {
	return {
		message: destination
			? `Destination ${destination} already exists (${conflict.kind}).`
			: `Destination already holds a ${conflict.kind} named "${conflict.name}".`,
		hint: NAMESPACE_CONFLICT_HINT,
	};
}

interface ToolError {
	code: string;
	message: string;
	hint?: string;
	details?: unknown;
}

// Only known rejections imply rollback. Transport/internal failures can occur
// after persistence, and must never encourage an unconditional retry.
const REJECTED_CODES = new Set([
	"invalid_request",
	"conflict",
	"not_found",
	"ambiguous_lix_ref",
	"malformed_context",
	"context_expired",
	"invalid_context",
	"context_user_mismatch",
	"context_client_mismatch",
	"LIX_INVALID_PARAM",
	"LIX_PARSE_ERROR",
	"LIX_UNSUPPORTED_SQL",
	"LIX_DIALECT_UNSUPPORTED",
	"LIX_TYPE_MISMATCH",
	"LIX_ERROR_UNIQUE",
	"LIX_ERROR_CONSTRAINT",
	"LIX_ERROR_NOT_NULL",
]);

export function sqlToolError(
	error: ToolError,
	options: {
		write: boolean;
		started: boolean;
		completed: boolean;
		statementCount: number;
	},
) {
	const details = error.details as
		| { statementIndex?: unknown; outcome?: unknown; capability?: unknown }
		| undefined;
	const index =
		details && typeof details === "object" ? details.statementIndex : undefined;
	const statementIndex =
		typeof index === "number" &&
		Number.isSafeInteger(index) &&
		index >= 0 &&
		index < options.statementCount
			? index
			: error.code.startsWith("LIX_") && options.statementCount === 1
				? 0
				: undefined;
	const outcome = options.completed
		? "committed"
		: details?.outcome === "committed" ||
			  details?.outcome === "not_committed" ||
			  details?.outcome === "unknown"
			? details.outcome
			: !options.started || REJECTED_CODES.has(error.code)
				? "not_committed"
				: "unknown";
	const binaryContent = BINARY_CONTENT_PATTERN.test(error.message);
	// Lix's own hint for this one says $1 whatever the statement bound.
	const hints = [binaryContent ? BINARY_CONTENT_HINT : error.hint];
	if (
		options.write &&
		!binaryContent &&
		details?.capability !== "file_content_query_insert" &&
		[
			"LIX_INVALID_PARAM",
			"LIX_PARSE_ERROR",
			"LIX_UNSUPPORTED_SQL",
			"LIX_TYPE_MISMATCH",
		].includes(error.code)
	)
		hints.push(SQL_TEXT_WRITE_RECIPE);
	if (options.write)
		hints.push(
			outcome === "unknown"
				? "The write outcome is unknown. Read the affected state before deciding whether to retry; do not blindly repeat the batch."
				: outcome === "committed"
					? "The batch committed. Do not repeat it; the failure occurred while preparing the response."
					: "The batch was not committed. Correct the reported problem before retrying.",
		);
	return {
		...error,
		...(statementIndex !== undefined
			? { statement_index: statementIndex }
			: {}),
		...(options.write ? { outcome } : {}),
		...(hints.some(Boolean) ? { hint: hints.filter(Boolean).join(" ") } : {}),
	};
}
