import assert from "node:assert/strict";
import test from "node:test";
import {
	CHANGED_FILES_SQL,
	READ_FILES_SQL,
	bytesToBase64,
	readFileContent,
	writeBytes,
	escapeLike,
	TEXT_CONTENT_LIMIT,
	fileWriteStatements,
	normalizeFilePath,
	parentDirectories,
} from "./file-tools.ts";

void test("paths are absolute files; directories come shallowest first", () => {
	assert.equal(normalizeFilePath(" /docs/notes.md "), "/docs/notes.md");
	for (const bad of ["docs/notes.md", "/docs/", "/", "/a//b.md", "/../x.md"]) {
		assert.throws(() => normalizeFilePath(bad), RangeError, bad);
	}
	assert.deepEqual(parentDirectories("/gtm/campaigns/icp.md"), [
		"/gtm",
		"/gtm/campaigns",
	]);
	assert.deepEqual(parentDirectories("/README.md"), []);
	assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

void test("a read hands over text, or says why it cannot", () => {
	assert.deepEqual(readFileContent(new TextEncoder().encode("héllo")), {
		content: "héllo",
		size: 6,
	});
	// Not text, and over the ceiling, are different answers — the old shape
	// gave both of them the same one.
	assert.deepEqual(readFileContent(new Uint8Array([0xff, 0xfe, 0x00])), {
		encoding: "binary",
		size: 3,
	});
	const huge = new Uint8Array(TEXT_CONTENT_LIMIT + 1).fill(0x41);
	assert.deepEqual(readFileContent(huge), {
		encoding: "too-large",
		size: TEXT_CONTENT_LIMIT + 1,
	});
});

void test("a write's bytes come from whichever field the caller used", () => {
	assert.deepEqual([...(writeBytes({ path: "/a", content: "A" }) ?? [])], [65]);
	assert.deepEqual(
		[
			...(writeBytes({
				path: "/a",
				content_base64: bytesToBase64(new Uint8Array([1, 2, 3])),
			}) ?? []),
		],
		[1, 2, 3],
	);
	assert.equal(writeBytes({ path: "/a" }), undefined);
});

void test("a write batch creates parents once, then upserts each file in one commit", () => {
	const statements = fileWriteStatements([
		{ path: "/gtm/campaigns/icp.md", content: "# ICP" },
		{
			path: "/gtm/leads.csv",
			content_base64: "AAEC",
			lixcol_metadata: { atelier_csv: { version: 1, columns: [] } },
		},
		{ path: "/gtm/notes.md", lixcol_metadata: null },
	]);
	assert.deepEqual(
		statements.map((statement) => statement.sql),
		[
			"INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING",
			"INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING",
			"INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content RETURNING id, path",
			"INSERT INTO lix_file (path, content, lixcol_metadata) VALUES ($1, $2, $3) ON CONFLICT (path) DO UPDATE SET content = excluded.content, lixcol_metadata = excluded.lixcol_metadata RETURNING id, path",
			"UPDATE lix_file SET lixcol_metadata = $2 WHERE path = $1 RETURNING id, path",
		],
	);
	assert.deepEqual(statements[0]?.params, [{ kind: "text", value: "/gtm" }]);
	assert.deepEqual(statements[1]?.params, [
		{ kind: "text", value: "/gtm/campaigns" },
	]);
	assert.deepEqual(statements[2]?.params, [
		{ kind: "text", value: "/gtm/campaigns/icp.md" },
		{ kind: "text", value: "# ICP" },
	]);
	assert.deepEqual(statements[3]?.params, [
		{ kind: "text", value: "/gtm/leads.csv" },
		{ kind: "blob", base64: "AAEC" },
		{ kind: "json", value: { atelier_csv: { version: 1, columns: [] } } },
	]);
	assert.deepEqual(statements[4]?.params, [
		{ kind: "text", value: "/gtm/notes.md" },
		{ kind: "null" },
	]);
	assert.deepEqual(
		statements.map((statement) => statement.path),
		[
			undefined,
			undefined,
			"/gtm/campaigns/icp.md",
			"/gtm/leads.csv",
			"/gtm/notes.md",
		],
	);
});

void test("the conflict and read queries bind every target path", () => {
	assert.equal(
		CHANGED_FILES_SQL(2),
		"SELECT from_path, to_path FROM lix_diff('lix_file', $1, $2) WHERE from_path IN ($3, $4) OR to_path IN ($3, $4)",
	);
	assert.equal(
		READ_FILES_SQL(1),
		"SELECT id, path, content, lixcol_metadata FROM lix_file WHERE path IN ($1)",
	);
});
