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

void test("isClearlyReadOnlySql keeps SELECT/VALUES and rejects writes", () => {
	assert.equal(isClearlyReadOnlySql("SELECT path FROM lix_file"), true);
	assert.equal(isClearlyReadOnlySql("VALUES (1)"), true);
	assert.equal(isClearlyReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x"), false);
	assert.equal(isClearlyReadOnlySql("SELECT 1; DELETE FROM lix_file"), false);
	assert.equal(isClearlyReadOnlySql("INSERT INTO lix_file (path) VALUES ($1)"), false);
});
