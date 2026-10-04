const MUTATING_SQL_FUNCTION =
	/^lix_(?:create_checkpoint|restore|revert(?:_range)?|apply|undo|redo)$/i;

/** Lex only the tokens needed for conservative write classification. */
function sqlTokens(sql: string): { value: string; quoted: boolean }[] {
	const tokens: { value: string; quoted: boolean }[] = [];
	for (let index = 0; index < sql.length;) {
		if (sql.startsWith("--", index)) {
			const offset = sql.slice(index + 2).search(/[\r\n]/);
			index = offset < 0 ? sql.length : index + 3 + offset;
		} else if (sql.startsWith("/*", index)) {
			let depth = 1;
			index += 2;
			while (index < sql.length && depth) {
				if (sql.startsWith("/*", index)) {
					depth++;
					index += 2;
				} else if (sql.startsWith("*/", index)) {
					depth--;
					index += 2;
				} else index++;
			}
		} else if (sql[index] === "'" || sql[index] === '"') {
			const escaped =
				sql[index] === "'" &&
				/[eE]/.test(sql[index - 1] ?? "") &&
				!/[a-z_0-9]/i.test(sql[index - 2] ?? "");
			const quote = sql[index++];
			let value = "";
			while (index < sql.length) {
				const character = sql[index++];
				if (escaped && character === "\\") {
					index++;
					continue;
				}
				if (character === quote) {
					if (sql[index] === quote) {
						value += quote;
						index++;
					} else break;
				} else value += character;
			}
			if (quote === '"') tokens.push({ value, quoted: true });
		} else {
			const dollar = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(sql.slice(index))?.[0];
			if (dollar) {
				const end = sql.indexOf(dollar, index + dollar.length);
				index = end < 0 ? sql.length : end + dollar.length;
				continue;
			}
			const word = /^[a-z_][a-z_0-9]*/i.exec(sql.slice(index))?.[0];
			if (word) {
				tokens.push({ value: word, quoted: false });
				index += word.length;
			} else {
				if (!/\s/.test(sql[index]!))
					tokens.push({ value: sql[index]!, quoted: false });
				index++;
			}
		}
	}
	return tokens;
}

/** MCP callers are trusted; the engine remains the SQL execution authority. */
export function sqlLooksLikeWrite(sql: string): boolean {
	const tokens = sqlTokens(sql);
	return tokens.some(
		(token, index) =>
			(!token.quoted && /^(?:INSERT|UPDATE|DELETE)$/i.test(token.value)) ||
			(MUTATING_SQL_FUNCTION.test(token.value) &&
				tokens[index + 1]?.value === "("),
	);
}

export function isClearlyReadOnlySql(sql: string): boolean {
	if (sqlLooksLikeWrite(sql)) return false;
	let tokens = sqlTokens(sql);
	// This gate must not treat a second statement as part of a read query.
	// String contents and quoted identifiers are separate tokens, so semicolons
	// inside either are not mistaken for statement separators.
	const semicolons = tokens
		.map((token, index) => ({ token, index }))
		.filter(({ token }) => !token.quoted && token.value === ";");
	if (semicolons.length > 1) return false;
	if (semicolons.length === 1) {
		if (semicolons[0]!.index !== tokens.length - 1) return false;
		tokens = tokens.slice(0, -1);
	}
	if (tokens.length === 0) return false;
	const isPunctuation = (index: number, punctuation: string) =>
		tokens[index] !== undefined &&
		tokens[index]!.quoted === false &&
		tokens[index]!.value === punctuation;
	const isKeyword = (index: number, keyword: string) =>
		tokens[index] !== undefined &&
		!tokens[index]!.quoted &&
		tokens[index]!.value.toUpperCase() === keyword;
	const skipParenthesized = (
		start: number,
		end: number,
	): { after: number; innerStart: number; innerEnd: number } | null => {
		if (!isPunctuation(start, "(")) return null;
		let depth = 0;
		for (let index = start; index < end; index++) {
			if (isPunctuation(index, "(")) depth++;
			else if (isPunctuation(index, ")")) {
				depth--;
				if (depth === 0)
					return { after: index + 1, innerStart: start + 1, innerEnd: index };
			}
		}
		return null;
	};
	const isReadQuery = (start: number, end: number): boolean => {
		const readStatement = (index: number) =>
			isKeyword(index, "SELECT") || isKeyword(index, "VALUES");
		if (readStatement(start)) return true;
		if (!isKeyword(start, "WITH")) return false;

		// Parse only the CTE envelope. Every CTE body must itself begin with a
		// read query; the full-token write scan above rejects DML anywhere inside
		// those bodies or in the outer statement.
		let index = isKeyword(start + 1, "RECURSIVE") ? start + 2 : start + 1;
		while (index < end) {
			// A CTE name is one identifier token, quoted or unquoted.
			if (
				tokens[index] === undefined ||
				isPunctuation(index, "(") ||
				isPunctuation(index, ",")
			)
				return false;
			index++;
			if (isPunctuation(index, "(")) {
				const columns = skipParenthesized(index, end);
				if (columns === null) return false;
				index = columns.after;
			}
			if (!isKeyword(index, "AS")) return false;
			index++;
			if (isKeyword(index, "NOT")) {
				index++;
				if (!isKeyword(index, "MATERIALIZED")) return false;
				index++;
			} else if (isKeyword(index, "MATERIALIZED")) {
				index++;
			}
			const body = skipParenthesized(index, end);
			if (body === null || !isReadQuery(body.innerStart, body.innerEnd))
				return false;
			index = body.after;
			if (isPunctuation(index, ",")) {
				index++;
				continue;
			}
			return readStatement(index);
		}
		return false;
	};

	return isReadQuery(0, tokens.length);
}
