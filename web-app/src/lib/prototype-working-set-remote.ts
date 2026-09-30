import type { Lix } from "@lix-js/sdk";
import type {
	PrototypeWorkingSetRemote,
	PrototypeWorkingSetScope,
} from "./prototype-working-set.ts";

export async function contentRevision(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Narrow text-content CAS. Metadata/rename changes are outside this contract.
 * The caller must bind `lix` to the exact `/lix/{repositoryId}` server URL used
 * to open it: the SDK exposes its active account and branch, but not the remote
 * repository route. This adapter verifies the account and pins the branch; the
 * prototype caller currently supplies the route binding in `authority()`.
 */
export async function createWorkingSetRemote(
	lix: Lix,
	expectedScope: PrototypeWorkingSetScope,
): Promise<PrototypeWorkingSetRemote & { close(): Promise<void> }> {
	const pinnedScope = { ...expectedScope };
	const session = await lix.openAnotherSession({
		branchId: pinnedScope.branchId,
	});
	try {
		if ((await session.activeAccountId()) !== pinnedScope.accountId) {
			throw new Error("Working-set authority account mismatch");
		}
	} catch (error) {
		await session.close().catch(() => undefined);
		throw error;
	}
	function assertScope(scope: PrototypeWorkingSetScope) {
		if (
			scope.accountId !== pinnedScope.accountId ||
			scope.repositoryId !== pinnedScope.repositoryId ||
			scope.branchId !== pinnedScope.branchId ||
			scope.fileId !== pinnedScope.fileId
		)
			throw new Error("Working-set authority scope mismatch");
	}
	async function read(scope: PrototypeWorkingSetScope) {
		assertScope(scope);
		const result = await session.execute(
			"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
			[scope.fileId],
		);
		if (result.rows.length !== 1 || typeof result.rows[0].content !== "string")
			throw new Error("Working-set file unavailable");
		const content = result.rows[0].content;
		return { content, revision: await contentRevision(content) };
	}
	return {
		read,
		close: () => session.close(),
		async compareAndSet(scope, operation) {
			assertScope(scope);
			if (
				(await contentRevision(operation.baseContent)) !==
				operation.baseRevision
			)
				throw new Error("Working-set base revision mismatch");
			// The server durably deduplicates this exact SQL + parameters under the
			// stable operation identity. A lost acknowledgment replays its receipt.
			const result = await session.execute(
				"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2 AND content = CAST($3 AS BYTEA) RETURNING id",
				[operation.content, scope.fileId, operation.baseContent],
				{ idempotencyKey: operation.operationId },
			);
			if (result.rows.length === 1)
				return {
					status: "committed",
					revision: await contentRevision(operation.content),
				};
			return { status: "conflict", actual: await read(scope) };
		},
	};
}
