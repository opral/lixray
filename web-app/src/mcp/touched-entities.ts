/**
 * Which files and directories an execute_sql batch touched, read from the
 * statements themselves. This feeds the human summary and the resource
 * links a host can render ("Wrote sales/lead-research.md"), so it only has
 * to be right for the SQL the operating guide teaches: INSERT with a column
 * list, UPDATE/DELETE with `path = $n` or a literal, and `path IN (…)`.
 * Anything it cannot read yields no entry rather than a wrong one.
 */

export type TouchedAction = "wrote" | "updated" | "deleted";

export type TouchedEntity = {
	readonly kind: "file" | "directory";
	readonly path: string;
	readonly action: TouchedAction;
};

type Statement = {
	readonly sql: string;
	readonly params?: ReadonlyArray<unknown>;
};

const TARGET =
	/^\s*(insert\s+into|update|delete\s+from)\s+(?:public\.)?lix_(file|directory)\b/i;

function paramText(params: ReadonlyArray<unknown> | undefined, ref: string) {
	const index = Number(ref.slice(1)) - 1;
	const value = params?.[index];
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		(value as { kind?: unknown }).kind === "text" &&
		typeof (value as { value?: unknown }).value === "string"
	)
		return (value as { value: string }).value;
	return null;
}

/** A `$n` reference or a single-quoted literal, resolved to text. */
function resolveToken(token: string, params?: ReadonlyArray<unknown>) {
	const trimmed = token.trim();
	if (/^\$\d+$/.test(trimmed)) return paramText(params, trimmed);
	const literal = /^'((?:[^']|'')*)'$/.exec(trimmed);
	return literal ? literal[1]!.replace(/''/g, "'") : null;
}

function isPath(value: string | null): value is string {
	return (
		value !== null &&
		value.startsWith("/") &&
		value.length > 1 &&
		value.length <= 512 &&
		!/[\r\n]/.test(value)
	);
}

/** Splits on commas outside parentheses and quotes. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quoted = false;
	let current = "";
	for (const character of text) {
		if (character === "'") quoted = !quoted;
		if (!quoted) {
			if (character === "(") depth += 1;
			if (character === ")") depth -= 1;
			if (character === "," && depth === 0) {
				parts.push(current);
				current = "";
				continue;
			}
		}
		current += character;
	}
	parts.push(current);
	return parts;
}

function insertPaths(sql: string, params?: ReadonlyArray<unknown>): string[] {
	const match = /\(([^)]*)\)\s*values\s*\(/i.exec(sql);
	if (!match) return [];
	const columns = match[1]!
		.split(",")
		.map((column) => column.trim().toLowerCase());
	const pathIndex = columns.indexOf("path");
	if (pathIndex === -1) return [];
	const paths: string[] = [];
	// Every VALUES tuple: `(…), (…)`.
	const tuples = sql.slice(match.index + match[0].length - 1);
	const tupleMatcher = /\(((?:[^()']|'(?:[^']|'')*'|\([^()]*\))*)\)/g;
	for (const tuple of tuples.matchAll(tupleMatcher)) {
		const values = splitTopLevel(tuple[1]!);
		const resolved = resolveToken(values[pathIndex] ?? "", params);
		if (isPath(resolved)) paths.push(resolved);
	}
	return paths;
}

function wherePaths(sql: string, params?: ReadonlyArray<unknown>): string[] {
	const paths: string[] = [];
	for (const match of sql.matchAll(/\bpath\s*=\s*(\$\d+|'(?:[^']|'')*')/gi)) {
		const resolved = resolveToken(match[1]!, params);
		if (isPath(resolved)) paths.push(resolved);
	}
	for (const match of sql.matchAll(/\bpath\s+in\s*\(([^)]*)\)/gi)) {
		for (const token of match[1]!.split(",")) {
			const resolved = resolveToken(token, params);
			if (isPath(resolved)) paths.push(resolved);
		}
	}
	return paths;
}

export function touchedEntities(
	statements: ReadonlyArray<Statement>,
): TouchedEntity[] {
	const touched = new Map<string, TouchedEntity>();
	for (const statement of statements) {
		const match = TARGET.exec(statement.sql);
		if (!match) continue;
		const verb = match[1]!.toLowerCase();
		const kind = match[2]!.toLowerCase() as TouchedEntity["kind"];
		const action: TouchedAction = verb.startsWith("insert")
			? "wrote"
			: verb === "update"
				? "updated"
				: "deleted";
		const paths = verb.startsWith("insert")
			? insertPaths(statement.sql, statement.params)
			: wherePaths(statement.sql, statement.params);
		for (const path of paths) {
			const key = `${kind}:${path}`;
			const previous = touched.get(key);
			touched.set(key, {
				kind,
				path,
				// A file written then updated in one batch was written.
				action:
					previous?.action === "wrote" && action === "updated"
						? "wrote"
						: action,
			});
		}
	}
	return [...touched.values()];
}

const MIME_TYPES: Record<string, string> = {
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	txt: "text/plain",
	html: "text/html",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	pdf: "application/pdf",
};

export function mimeTypeForPath(path: string): string | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension && extension !== path ? MIME_TYPES[extension] : undefined;
}

/** "Wrote sales/lead-research.md · Updated leads.csv · 7 rows affected" */
export function describeTouched(
	touched: ReadonlyArray<TouchedEntity>,
	rowsAffected: number,
): string {
	const byAction = new Map<TouchedAction, string[]>();
	for (const entity of touched) {
		const list = byAction.get(entity.action) ?? [];
		list.push(entity.path.replace(/^\//, ""));
		byAction.set(entity.action, list);
	}
	const parts: string[] = [];
	for (const [action, label] of [
		["wrote", "Wrote"],
		["updated", "Updated"],
		["deleted", "Deleted"],
	] as const) {
		const paths = byAction.get(action);
		if (paths?.length) parts.push(`${label} ${paths.join(", ")}`);
	}
	parts.push(`${rowsAffected} ${rowsAffected === 1 ? "row" : "rows"} affected`);
	return parts.join(" · ");
}
