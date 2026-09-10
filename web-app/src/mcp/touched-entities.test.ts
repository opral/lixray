import assert from "node:assert/strict";
import test from "node:test";
import {
	describeTouched,
	mimeTypeForPath,
	touchedEntities,
} from "./touched-entities.ts";

const text = (value: string) => ({ kind: "text", value });

void test("reads the path of an INSERT from its column list and params", () => {
	assert.deepEqual(
		touchedEntities([
			{
				sql: "INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content",
				params: [text("/sales/lead-research.md"), text("/not a path\nbody")],
			},
		]),
		[{ kind: "file", path: "/sales/lead-research.md", action: "wrote" }],
	);
});

void test("reads several VALUES tuples, literals, and directories", () => {
	assert.deepEqual(
		touchedEntities([
			{
				sql: "INSERT INTO lix_directory (path) VALUES ('/sales'), ($1) ON CONFLICT (path) DO NOTHING",
				params: [text("/sales/archive")],
			},
		]),
		[
			{ kind: "directory", path: "/sales", action: "wrote" },
			{ kind: "directory", path: "/sales/archive", action: "wrote" },
		],
	);
});

void test("UPDATE and DELETE read paths from WHERE, by param, literal, or IN list", () => {
	assert.deepEqual(
		touchedEntities([
			{
				sql: "UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE path = $2",
				params: [text("body"), text("/gtm/leads.csv")],
			},
			{
				sql: "DELETE FROM lix_file WHERE path IN ('/old.csv', $1)",
				params: [text("/older.csv")],
			},
			{ sql: "DELETE FROM public.lix_file WHERE path = 'it''s.md'" },
		]),
		[
			{ kind: "file", path: "/gtm/leads.csv", action: "updated" },
			{ kind: "file", path: "/old.csv", action: "deleted" },
			{ kind: "file", path: "/older.csv", action: "deleted" },
		],
	);
});

void test("statements it cannot read yield nothing, never a guess", () => {
	assert.deepEqual(
		touchedEntities([
			{
				sql: "UPDATE lix_file SET content = $1 WHERE id = $2",
				params: [text("x"), text("id")],
			},
			{
				sql: "INSERT INTO lix_key_value (key, value) VALUES ($1, $2)",
				params: [text("/k"), text("v")],
			},
			{ sql: "SELECT path FROM lix_file WHERE path = '/read.md'" },
		]),
		[],
	);
});

void test("a file written and then updated in one batch was written", () => {
	assert.deepEqual(
		touchedEntities([
			{
				sql: "INSERT INTO lix_file (path, content) VALUES ('/a.md', $1)",
				params: [text("x")],
			},
			{
				sql: "UPDATE lix_file SET content = $1 WHERE path = '/a.md'",
				params: [text("y")],
			},
		]),
		[{ kind: "file", path: "/a.md", action: "wrote" }],
	);
});

void test("describes the batch by action, then rows", () => {
	assert.equal(
		describeTouched(
			[
				{ kind: "file", path: "/sales/lead-research.md", action: "wrote" },
				{ kind: "file", path: "/gtm/leads.csv", action: "updated" },
				{ kind: "directory", path: "/sales", action: "wrote" },
			],
			7,
		),
		"Wrote sales/lead-research.md, sales · Updated gtm/leads.csv · 7 rows affected",
	);
	assert.equal(describeTouched([], 1), "1 row affected");
	assert.equal(mimeTypeForPath("/x/notes.MD"), "text/markdown");
	assert.equal(mimeTypeForPath("/x/Makefile"), undefined);
});
