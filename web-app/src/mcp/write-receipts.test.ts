import { executeBatch } from "../lib/execute-batch.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Lix } from "@lix-js/sdk";
import { openMemoryWasmBinding } from "../../../vendor/lix/packages/js-sdk/dist/binding.node-wasm.js";

void test("a failed batch rolls back every preceding statement", async () => {
	const lix = new Lix(await openMemoryWasmBinding());
	try {
		await assert.rejects(
			executeBatch(lix, [
				{
					sql: "INSERT INTO lix_file (path, content) VALUES ('/rollback.md', CAST('A' AS BYTEA))",
				},
				{ sql: "SELECT * FROM missing_batch_table" },
			]),
		);
		const result = await lix.query(
			"SELECT id FROM lix_file WHERE path = '/rollback.md'",
		);
		assert.equal(result.length, 0);
	} finally {
		await lix.close();
	}
});

void test("a write's receipt names a span, and the span says what changed", async () => {
	const lix = new Lix(await openMemoryWasmBinding());
	let activeTransaction:
		| Awaited<ReturnType<Lix["beginTransaction"]>>
		| undefined;
	try {
		await lix.execute(
			"INSERT INTO lix_file (path, content) VALUES ('/notes.md', CAST('before' AS BYTEA))",
		);
		const tx = await lix.beginTransaction();
		activeTransaction = tx;
		for (const [path, content] of [
			["/notes.md", "after"],
			["/new.md", ""],
		])
			await tx.execute(
				"INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content",
				[path, content],
			);
		activeTransaction = undefined;
		const receipt = await tx.commit();
		assert.ok(receipt.commit);

		// The write carried no bytes of its own. Both sides come from the
		// diff between the commits it moved between — the same query a
		// checkpoint or any two commits would answer.
		const changes = await lix.execute(
			"SELECT to_path, from_content, to_content FROM lix_diff('lix_file', $1, $2) ORDER BY to_path",
			[receipt.commit.before, receipt.commit.after],
		);
		assert.deepEqual(
			changes.rows.map((row) => [
				row.to_path,
				row.from_content,
				row.to_content,
			]),
			[
				// A created file has no before side; an empty one has zero bytes.
				["/new.md", null, new Uint8Array()],
				[
					"/notes.md",
					new TextEncoder().encode("before"),
					new TextEncoder().encode("after"),
				],
			],
		);

		// A checkpoint made afterwards is its own commit and does not rewrite
		// the receipt the write already returned.
		const checkpoint = await lix.execute(
			"SELECT commit_id FROM lix_create_checkpoint(NULL, NULL)",
		);
		const actual = await lix.execute(
			"SELECT commit_id FROM lix_branch WHERE id = lix_active_branch_id()",
		);
		assert.equal(actual.rows[0]?.commit_id, checkpoint.rows[0]?.commit_id);
		const history = await lix.execute(
			"SELECT is_checkpoint FROM lix_log() WHERE commit_id = $1",
			[checkpoint.rows[0]?.commit_id as string],
		);
		assert.equal(history.rows[0]?.is_checkpoint, true);
		assert.notEqual(receipt.commit.after, checkpoint.rows[0]?.commit_id);
	} finally {
		await activeTransaction?.rollback();
		await lix.close();
	}
});

void test("a real atomic batch has statement images and one receipt for its net A to B to A transition", async () => {
	const lix = new Lix(await openMemoryWasmBinding());
	try {
		await lix.execute(
			"INSERT INTO lix_file (path, content) VALUES ('/notes.md', CAST('A' AS BYTEA))",
		);
		const batch = await executeBatch(lix, [
			{
				sql: "UPDATE lix_file SET content = CAST('B' AS BYTEA) WHERE path = '/notes.md' RETURNING OLD.content AS before, NEW.content AS after",
			},
			{
				sql: "UPDATE lix_file SET content = CAST('A' AS BYTEA) WHERE path = '/notes.md' RETURNING OLD.content AS before, NEW.content AS after",
			},
		]);
		assert.ok(batch.commit);
		assert.deepEqual(
			batch.results.map((result) => [
				new TextDecoder().decode(result.rows[0]?.before as Uint8Array),
				new TextDecoder().decode(result.rows[0]?.after as Uint8Array),
			]),
			[
				["A", "B"],
				["B", "A"],
			],
		);
		assert.equal(
			batch.results.some((result) => "commit" in result),
			false,
		);
		const changes = await lix.execute(
			"SELECT id FROM lix_diff('lix_file', $1, $2)",
			[batch.commit.before, batch.commit.after],
		);
		assert.equal(changes.rows.length, 0);
	} finally {
		await lix.close();
	}
});
