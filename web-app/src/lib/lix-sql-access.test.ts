import assert from "node:assert/strict";
import test from "node:test";
import { isClearlyReadOnlySql, sqlLooksLikeWrite } from "./lix-sql-access.ts";

void test("sqlLooksLikeWrite matches INSERT, UPDATE, and DELETE", () => {
	assert.equal(sqlLooksLikeWrite("INSERT INTO example VALUES (1)"), true);
	assert.equal(sqlLooksLikeWrite("update example set value = 2"), true);
	assert.equal(sqlLooksLikeWrite("SELECT 1; DELETE FROM example"), true);
	assert.equal(sqlLooksLikeWrite("SELECT 1"), false);
	assert.equal(sqlLooksLikeWrite("VALUES (1)"), false);
	assert.equal(sqlLooksLikeWrite("SELECT inserted_at, updated_at"), false);
});

void test("sqlLooksLikeWrite recognizes undo and redo SQL functions", () => {
	assert.equal(sqlLooksLikeWrite("SELECT commit_id FROM lix_undo()"), true);
	assert.equal(sqlLooksLikeWrite("SELECT commit_id FROM lix_redo($1)"), true);
});

void test("isClearlyReadOnlySql keeps SELECT/VALUES and rejects writes", () => {
	assert.equal(isClearlyReadOnlySql("SELECT path FROM lix_file"), true);
	assert.equal(isClearlyReadOnlySql("VALUES (1)"), true);
	assert.equal(
		isClearlyReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x"),
		true,
	);
	assert.equal(isClearlyReadOnlySql("SELECT 1; DELETE FROM lix_file"), false);
	assert.equal(
		isClearlyReadOnlySql("INSERT INTO lix_file (path) VALUES ($1)"),
		false,
	);
});

void test("isClearlyReadOnlySql accepts read-only CTEs and rejects modifying CTEs", () => {
	for (const sql of [
		"WITH x AS (SELECT 1) SELECT * FROM x",
		"WITH RECURSIVE x(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM x) SELECT * FROM x",
		"WITH x AS NOT MATERIALIZED (SELECT 1), y AS MATERIALIZED (SELECT * FROM x) VALUES (1)",
		"WITH x AS (WITH y AS (SELECT 1) SELECT * FROM y) SELECT * FROM x",
		'WITH "(" ("(") AS (SELECT \')\') SELECT * FROM "(";',
		"/* read */ WITH x AS (SELECT 'DELETE FROM hidden') SELECT * FROM x",
		"SELECT ';' AS value;",
	]) {
		assert.equal(isClearlyReadOnlySql(sql), true, sql);
	}

	for (const sql of [
		"WITH x AS (DELETE FROM lix_file RETURNING *) SELECT * FROM x",
		"WITH x AS (SELECT 1), y AS (WITH z AS (UPDATE lix_file SET path = '/' RETURNING *) SELECT * FROM z) SELECT * FROM y",
		"WITH x AS (SELECT 1) DELETE FROM lix_file",
		"WITH x AS (SELECT 1) INSERT INTO lix_file(path) VALUES ('/x')",
		"WITH x AS (SELECT 1) UPDATE lix_file SET path = '/x'",
		"WITH x AS (CREATE TABLE hidden (id INT)) SELECT 1",
		"WITH x AS (SELECT 1) CREATE TABLE hidden (id INT)",
		"WITH x AS (SELECT 1) SELECT 1; CREATE TABLE hidden (id INT)",
		"SELECT 1; SELECT 2",
		"SELECT 1;;",
		"WITH x AS (SELECT 1)",
	]) {
		assert.equal(isClearlyReadOnlySql(sql), false, sql);
	}
});

void test("mutating SELECT functions require write access", () => {
	for (const name of [
		"lix_create_checkpoint",
		"lix_restore",
		"lix_revert",
		"lix_revert_range",
		"lix_apply",
	]) {
		for (const sql of [
			`SELECT commit_id FROM ${name}($1)`,
			`SELECT commit_id FROM public."${name}" /* comment */ ($1)`,
		]) {
			assert.equal(sqlLooksLikeWrite(sql), true);
			assert.equal(isClearlyReadOnlySql(sql), false);
		}
	}
});

void test("function names inside SQL text and comments stay read-only", () => {
	for (const sql of [
		"SELECT 'lix_restore($1)' AS example",
		"SELECT $$lix_apply(a,b)$$",
		"SELECT $text$lix_revert(a)$text$",
		"SELECT 1 /* outer /* lix_restore() */ comment */",
		"SELECT 1 -- lix_revert_range()",
		'SELECT "delete" FROM example',
	]) {
		assert.equal(sqlLooksLikeWrite(sql), false, sql);
		assert.equal(isClearlyReadOnlySql(sql), true, sql);
	}
});
