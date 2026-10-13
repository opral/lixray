import type {
	Lix,
	SqlParam,
	StatementResult,
	ExecuteOptions,
} from "@lix-js/sdk";

/** Keep the application batch contract atomic using the SDK transaction API. */
export async function executeBatch(
	lix: Lix,
	statements: readonly { sql: string; params?: readonly SqlParam[] }[],
	options?: ExecuteOptions,
) {
	const { value: results, commit } = await lix.transaction(async (tx) => {
		const results: StatementResult[] = [];
		for (const [statementIndex, statement] of statements.entries()) {
			try {
				results.push(
					await tx.execute(statement.sql, statement.params, options),
				);
			} catch (caught) {
				if (caught instanceof Error) {
					const error = caught as Error & { details?: Record<string, unknown> };
					error.details = { ...error.details, statementIndex };
				}
				throw caught;
			}
		}
		return results;
	});
	return { results, commit };
}
