export const SQL_TEXT_WRITE_RECIPE =
	'For text files use UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE path = $2 with two kind: "text" parameters (content, path). REPLACE, CONCAT and || can be used inside the BYTEA cast. Use one SQL statement per statements[] entry; use an explicit ON CONFLICT (path) target.';

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
	const details = error.details as { statementIndex?: unknown } | undefined;
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
		: !options.started || REJECTED_CODES.has(error.code)
			? "not_committed"
			: "unknown";
	const hints = [error.hint];
	if (
		options.write &&
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
