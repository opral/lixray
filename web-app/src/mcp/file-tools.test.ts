import assert from "node:assert/strict";
import test from "node:test";
import {
	READ_FILES_SQL,
	readFileContent,
	escapeLike,
	TEXT_CONTENT_LIMIT,
	normalizeFilePath,
} from "./file-tools.ts";

void test("paths are absolute files", () => {
	assert.equal(normalizeFilePath(" /docs/notes.md "), "/docs/notes.md");
	for (const bad of ["docs/notes.md", "/docs/", "/", "/a//b.md", "/../x.md"]) {
		assert.throws(() => normalizeFilePath(bad), RangeError, bad);
	}
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

void test("the read query binds every target path", () => {
	assert.equal(
		READ_FILES_SQL(1),
		"SELECT id, path, content, lixcol_metadata FROM lix_file WHERE path IN ($1)",
	);
});
