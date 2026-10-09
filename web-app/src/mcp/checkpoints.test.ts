import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import {
	openLix,
	type Lix,
	type LixTransaction,
	type SqlParam,
} from "@lix-js/sdk";
import {
	checkpointInTransaction,
	completeCheckpointReceipt,
	updateCheckpointInTransaction,
	descriptionDocument,
	type CheckpointInput,
} from "./checkpoints.ts";
import type { TransactionClient, WireValue } from "./lix-service.ts";

function adapter(lix: Lix | LixTransaction): TransactionClient {
	return {
		execute: async ({ sql, params }) => {
			const result = await lix.execute(
				sql,
				params?.map((v) =>
					v.kind === "null"
						? null
						: v.kind === "blob"
							? new Uint8Array(Buffer.from(v.base64, "base64"))
							: (v.value as SqlParam),
				),
			);
			return {
				columns: result.columns.map((c) => c.name),
				rows: result.rows.map((row) =>
					result.columns.map((c, index) => {
						const value = Array.isArray(row) ? row[index] : row[c.name];
						return (
							value === null
								? { kind: "null" }
								: { kind: typeof value === "string" ? "text" : "json", value }
						) as WireValue;
					}),
				),
				rowsAffected: result.rowsAffected,
				notices: [],
			};
		},
	};
}
async function create(
	lix: Lix,
	input: CheckpointInput,
	span?: { before: string; after: string },
) {
	const tx = await lix.beginTransaction();
	try {
		const receipt = await checkpointInTransaction(adapter(tx), input, span);
		const result = await tx.commit();
		return await completeCheckpointReceipt(
			adapter(lix),
			receipt,
			result.commit?.after ?? receipt.commit_id,
		);
	} catch (e) {
		await tx.rollback().catch(() => {});
		throw e;
	}
}
async function update(
	lix: Lix,
	commit: string,
	input: { title?: string; description?: string | null },
) {
	const tx = await lix.beginTransaction();
	try {
		await updateCheckpointInTransaction(adapter(tx), commit, input);
		await tx.commit();
	} catch (e) {
		await tx.rollback().catch(() => {});
		throw e;
	}
}
const all = { type: "all" } as const;

void test("full checkpoint stores metadata atomically and returns identifiers and dependencies", async () => {
	const lix = await openLix();
	try {
		await lix.execute(
			"INSERT INTO lix_file (path, content) VALUES ('/docs/a.txt', CAST('Hello' AS BYTEA))",
		);
		const r = await create(lix, {
			title: "Write greeting",
			description: "A greeting.\nReady to share.",
			scope: all,
		});
		assert.equal(r.head_commit_id, r.commit_id);
		assert.equal(r.included_scope_complete, true);
		assert.ok(r.included_scope.some((s) => s.relation === "lix_file"));
		assert.ok(r.included_scope.some((s) => s.relation === "lix_directory"));
		assert.deepEqual(
			(
				await lix.execute("SELECT title FROM lix_conversation WHERE id = $1", [
					r.conversation_id!,
				])
			).rows,
			[{ title: "Write greeting" }],
		);
		assert.deepEqual(
			(
				await lix.execute(
					"SELECT body FROM lix_comment WHERE conversation_id = $1",
					[r.conversation_id!],
				)
			).rows[0]?.body,
			descriptionDocument("A greeting.\nReady to share.").value,
		);
	} finally {
		await lix.close();
	}
});
void test("selected checkpoint includes ancestors and leaves unrelated changes pending", async () => {
	const lix = await openLix();
	try {
		await lix.execute(
			"INSERT INTO lix_file (path, content) VALUES ('/docs/a.txt', CAST('A' AS BYTEA)), ('/other.txt', CAST('B' AS BYTEA))",
		);
		const refs = (
			await lix.execute(
				"SELECT CAST(row_ref AS TEXT) AS ref FROM lix_diff('lix_file') WHERE to_path = '/docs/a.txt'",
			)
		).rows;
		const r = await create(lix, {
			title: "Finish document A",
			scope: {
				type: "selected",
				selections: [
					{ relation: "lix_file", row_refs: [refs[0]!.ref as string] },
				],
			},
		});
		assert.notEqual(r.head_commit_id, r.commit_id);
		assert.ok(r.included_scope.some((s) => s.relation === "lix_directory"));
		assert.equal(
			r.included_scope.find((s) => s.relation === "lix_file")?.row_refs.length,
			1,
		);
		assert.deepEqual(
			(await lix.execute("SELECT to_path FROM lix_diff('lix_file')")).rows,
			[{ to_path: "/other.txt" }],
		);
	} finally {
		await lix.close();
	}
});
void test("batch scope selects affected rows; stale head and invalid title create no milestone", async () => {
	const lix = await openLix();
	try {
		await lix.execute(
			"INSERT INTO lix_key_value (key, value) VALUES ('unrelated', 'draft')",
		);
		const write = await lix.execute(
			"INSERT INTO lix_key_value (key, value) VALUES ('batch', 'done')",
		);
		const r = await create(
			lix,
			{
				title: "Finish batch",
				scope: { type: "selected", selections: [] },
				expected_head_commit_id: write.commit!.after,
			},
			write.commit!,
		);
		assert.equal(
			r.included_scope.find((s) => s.relation === "lix_key_value")?.row_refs
				.length,
			1,
		);
		assert.deepEqual(
			(await lix.execute("SELECT key FROM lix_diff('lix_key_value')")).rows,
			[{ key: "unrelated" }],
		);
		await assert.rejects(
			create(lix, {
				title: "Conflict",
				scope: all,
				expected_head_commit_id: write.commit!.after,
			}),
			/head changed/,
		);
		await assert.rejects(
			create(lix, { title: "   ", scope: all }),
			/non-empty/,
		);
		assert.equal(
			(await lix.execute("SELECT commit_id FROM lix_log() WHERE is_checkpoint"))
				.rows.length,
			1,
		);
	} finally {
		await lix.close();
	}
});
for (const hasDescription of [true, false]) {
	void test(`metadata corrections preserve replies and checkpoint identity (opening description: ${hasDescription})`, async () => {
		const lix = await openLix();
		try {
			const r = await create(lix, {
				title: "First",
				...(hasDescription ? { description: "Original" } : {}),
				scope: all,
			});
			await lix.execute(
				"INSERT INTO lix_comment (id, conversation_id, body, lixcol_global) VALUES ($1, $2, $3, true)",
				[
					crypto.randomUUID(),
					r.conversation_id!,
					descriptionDocument("Reply").value,
				],
			);
			await update(lix, r.commit_id, {
				title: "Corrected",
				description: "Context",
			});
			await update(lix, r.commit_id, { description: null });
			await update(lix, r.commit_id, { description: "Final" });
			assert.deepEqual(
				(
					await lix.execute(
						"SELECT title FROM lix_conversation WHERE id = $1",
						[r.conversation_id!],
					)
				).rows,
				[{ title: "Corrected" }],
			);
			const comments = (
				await lix.execute(
					"SELECT body FROM lix_comment WHERE conversation_id = $1 ORDER BY lixcol_created_at, id",
					[r.conversation_id!],
				)
			).rows;
			assert.equal(comments.length, 2);
			assert.ok(
				comments.some((c) =>
					isDeepStrictEqual(c.body, descriptionDocument("Reply").value),
				),
			);
			assert.ok(
				comments.some((c) =>
					isDeepStrictEqual(c.body, descriptionDocument("Final").value),
				),
			);
			assert.deepEqual(
				(
					await lix.execute(
						"SELECT commit_id FROM lix_log() WHERE is_checkpoint",
					)
				).rows,
				[{ commit_id: r.commit_id }],
			);
		} finally {
			await lix.close();
		}
	});
}
