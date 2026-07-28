import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const railwayEntrypoint = new URL("../src/railway-server.ts", import.meta.url);

void test("the Railway entrypoint uses only the Node SQL parser", async () => {
	const source = await readFile(railwayEntrypoint, "utf8");

	assert.match(source, /from ["']\.\/lib\/node-lix-sql-parser["']/);
	assert.doesNotMatch(source, /@lix-js\/sdk\/workerd/);
	assert.doesNotMatch(source, /import\.meta\.env\.DEV/);
});
