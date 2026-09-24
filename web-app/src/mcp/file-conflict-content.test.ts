import assert from "node:assert/strict";
import test from "node:test";
import { readFileContent, TEXT_CONTENT_LIMIT } from "./file-conflict-content.ts";

void test("conflict details bound text and identify binary content", () => {
	assert.deepEqual(readFileContent(new TextEncoder().encode("héllo")), {
		content: "héllo",
		size: 6,
	});
	// Binary content and content above the response ceiling have distinct shapes.
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
