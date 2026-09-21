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
	const first = sqlTokens(sql)[0];
	return (
		first !== undefined &&
		!first.quoted &&
		/^(?:SELECT|VALUES)$/i.test(first.value)
	);
}
