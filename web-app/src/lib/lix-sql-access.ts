/**
 * Lix's SQL script parser result at the authorization boundary. Keeping this
 * structural type independent from the Node/WASM binding lets every transport
 * classify exactly what the engine will execute.
 */
export type ParseSqlScript = (
	sql: string,
	providedParamCount: number,
) => { statements: ReadonlyArray<{ sql: string }> };

export function isClearlyReadOnlySql(sql: string): boolean {
	const keyword = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase();
	return keyword === "SELECT" || keyword === "VALUES";
}
