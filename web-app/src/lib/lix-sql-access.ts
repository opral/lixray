const WRITE_SQL_VERB = /\b(?:INSERT|UPDATE|DELETE)\b/i;

/** Cheap write-verb check. MCP callers are trusted; we do not parse SQL. */
export function sqlLooksLikeWrite(sql: string): boolean {
	return WRITE_SQL_VERB.test(sql);
}

export function isClearlyReadOnlySql(sql: string): boolean {
	if (sqlLooksLikeWrite(sql)) return false;
	const keyword = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase();
	return keyword === "SELECT" || keyword === "VALUES";
}
