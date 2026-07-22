const MAX_SANITIZED_SQL_LENGTH = 4096;

interface McpSqlStatementObservation {
	index: number;
	operation: string;
	sanitizedSql: string;
	shapeId: string;
	parameterCount: number;
	redactedLiteralCount: number;
	truncated: boolean;
}

export interface McpExecuteInputObservation {
	statementCount: number;
	statements: Array<McpSqlStatementObservation>;
}

interface McpExecuteResultObservation {
	index: number;
	columnCount: number;
	rowCount: number;
	rowsAffected: number;
	noticeCodes: Array<string>;
}

export interface McpExecuteOutputObservation {
	resultCount: number;
	rowCount: number;
	rowsAffected: number;
	noticeCodes: Array<string>;
	results: Array<McpExecuteResultObservation>;
}

export function observeExecuteInput(
	value: unknown,
): McpExecuteInputObservation | undefined {
	if (!Array.isArray(value)) return undefined;
	const statements = value.flatMap((candidate, index) => {
		if (!candidate || typeof candidate !== "object") return [];
		const record = candidate as Record<string, unknown>;
		if (typeof record.sql !== "string" || record.sql.trim().length === 0) {
			return [];
		}
		const sanitized = sanitizeSql(record.sql);
		return [
			{
				index,
				operation: sqlOperation(sanitized.sql),
				sanitizedSql: sanitized.sql,
				shapeId: `fnv1a32:${fnv1a32(sanitized.sql)}`,
				parameterCount: Array.isArray(record.params) ? record.params.length : 0,
				redactedLiteralCount: sanitized.redactedLiteralCount,
				truncated: sanitized.truncated,
			},
		];
	});
	return statements.length === 0
		? undefined
		: { statementCount: statements.length, statements };
}

export function observeExecuteOutput(
	value: unknown,
): McpExecuteOutputObservation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rawResults = (value as Record<string, unknown>).results;
	if (!Array.isArray(rawResults)) return undefined;

	const results = rawResults.flatMap((candidate, index) => {
		if (!candidate || typeof candidate !== "object") return [];
		const result = candidate as Record<string, unknown>;
		return [
			{
				index,
				columnCount: Array.isArray(result.columns) ? result.columns.length : 0,
				rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
				rowsAffected:
					typeof result.rowsAffected === "number" &&
					Number.isFinite(result.rowsAffected)
						? Math.max(0, Math.trunc(result.rowsAffected))
						: 0,
				noticeCodes: noticeCodes(result.notices),
			},
		];
	});
	const allNoticeCodes = Array.from(
		new Set(results.flatMap((result) => result.noticeCodes)),
	).sort();
	return {
		resultCount: results.length,
		rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
		rowsAffected: results.reduce((sum, result) => sum + result.rowsAffected, 0),
		noticeCodes: allNoticeCodes,
		results,
	};
}

export function mcpSurfaceVersion(descriptors: Array<unknown>): string {
	return `fnv1a32:${fnv1a32(JSON.stringify(descriptors))}`;
}

function noticeCodes(value: unknown): Array<string> {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value.flatMap((candidate): Array<string> => {
				if (!candidate || typeof candidate !== "object") return [];
				const code = (candidate as Record<string, unknown>).code;
				return typeof code === "string" &&
					/^[A-Z][A-Z0-9_:-]{1,127}$/.test(code)
					? [code]
					: [];
			}),
		),
	).sort();
}

function sanitizeSql(value: string): {
	sql: string;
	redactedLiteralCount: number;
	truncated: boolean;
} {
	let output = "";
	let redactedLiteralCount = 0;
	let index = 0;
	while (index < value.length) {
		const character = value[index];
		const next = value[index + 1];

		if (character === "-" && next === "-") {
			index += 2;
			while (index < value.length && value[index] !== "\n") index += 1;
			output += " ";
			continue;
		}
		if (character === "/" && next === "*") {
			index += 2;
			while (
				index < value.length &&
				!(value[index] === "*" && value[index + 1] === "/")
			) {
				index += 1;
			}
			index = Math.min(value.length, index + 2);
			output += " ";
			continue;
		}
		if (character === "'") {
			redactedLiteralCount += 1;
			output += "?";
			index += 1;
			while (index < value.length) {
				if (value[index] !== "'") {
					index += 1;
					continue;
				}
				if (value[index + 1] === "'") {
					index += 2;
					continue;
				}
				index += 1;
				break;
			}
			continue;
		}
		if (character === '"') {
			const start = index;
			index += 1;
			while (index < value.length) {
				if (value[index] !== '"') {
					index += 1;
					continue;
				}
				if (value[index + 1] === '"') {
					index += 2;
					continue;
				}
				index += 1;
				break;
			}
			output += value.slice(start, index).toLowerCase();
			continue;
		}
		if (character === "$" && next !== undefined && /[0-9]/.test(next)) {
			output += "?";
			index += 2;
			while (index < value.length && /[0-9]/.test(value[index] ?? "")) {
				index += 1;
			}
			continue;
		}
		if (character === "$") {
			const delimiter = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(
				value.slice(index),
			)?.[0];
			if (delimiter) {
				redactedLiteralCount += 1;
				output += "?";
				const closingIndex = value.indexOf(delimiter, index + delimiter.length);
				index =
					closingIndex === -1 ? value.length : closingIndex + delimiter.length;
				continue;
			}
		}
		if (isNumericLiteralStart(value, index)) {
			redactedLiteralCount += 1;
			output += "?";
			index = numericLiteralEnd(value, index);
			continue;
		}
		output += /\s/.test(character ?? "") ? " " : character.toLowerCase();
		index += 1;
	}

	const normalized = output
		.replace(/\b[bx]\?/g, "?")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),;])\s*/g, "$1")
		.trim();
	const truncated = normalized.length > MAX_SANITIZED_SQL_LENGTH;
	return {
		sql: truncated ? normalized.slice(0, MAX_SANITIZED_SQL_LENGTH) : normalized,
		redactedLiteralCount,
		truncated,
	};
}

function isNumericLiteralStart(value: string, index: number): boolean {
	const character = value[index];
	if (character === undefined || !/[0-9]/.test(character)) return false;
	const previous = value[index - 1];
	return previous === undefined || !/[a-zA-Z0-9_$]/.test(previous);
}

function numericLiteralEnd(value: string, start: number): number {
	let index = start;
	if (
		value[index] === "0" &&
		/[xXbB]/.test(value[index + 1] ?? "") &&
		/[0-9a-fA-F]/.test(value[index + 2] ?? "")
	) {
		index += 2;
		while (index < value.length && /[0-9a-fA-F]/.test(value[index] ?? "")) {
			index += 1;
		}
		return index;
	}
	while (index < value.length && /[0-9]/.test(value[index] ?? "")) index += 1;
	if (value[index] === "." && /[0-9]/.test(value[index + 1] ?? "")) {
		index += 1;
		while (index < value.length && /[0-9]/.test(value[index] ?? "")) {
			index += 1;
		}
	}
	if (/[eE]/.test(value[index] ?? "")) {
		let exponentIndex = index + 1;
		if (/[+-]/.test(value[exponentIndex] ?? "")) exponentIndex += 1;
		if (/[0-9]/.test(value[exponentIndex] ?? "")) {
			index = exponentIndex + 1;
			while (index < value.length && /[0-9]/.test(value[index] ?? "")) {
				index += 1;
			}
		}
	}
	return index;
}

function sqlOperation(sanitizedSql: string): string {
	const operations = Array.from(
		sanitizedSql.matchAll(
			/\b(select|insert|update|delete|merge|create|alter|drop|explain|pragma|vacuum|begin|commit|rollback|with)\b/g,
		),
		(match) => match[1],
	);
	if (operations[0] === "with") {
		return (
			operations.find((operation) =>
				["select", "insert", "update", "delete", "merge"].includes(operation),
			) ?? "with"
		).toUpperCase();
	}
	return (operations[0] ?? "UNKNOWN").toUpperCase();
}

function fnv1a32(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
