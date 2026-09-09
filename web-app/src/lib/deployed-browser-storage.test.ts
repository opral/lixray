import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webSource = fileURLToPath(new URL("../", import.meta.url));
const atelierSource = fileURLToPath(
	new URL("../../../vendor/atelier/src/", import.meta.url),
);
const atelierPreviewSource = fileURLToPath(
	new URL("../../../vendor/atelier/preview/web/", import.meta.url),
);

void test("the deployed Lixray and Atelier source graph uses OPFS exclusively", async () => {
	const forbidden = ["indexed", "db"].join("");
	const offenders: string[] = [];
	for (const root of [webSource, atelierSource, atelierPreviewSource]) {
		for (const file of await sourceFiles(root)) {
			const source = await readFile(file, "utf8");
			if (source.toLowerCase().includes(forbidden)) offenders.push(file);
		}
	}
	assert.deepEqual(offenders, []);

	const repositorySession = await readFile(
		new URL("./repository-lix-session.ts", import.meta.url),
		"utf8",
	);
	assert.match(repositorySession, /new OpfsStorage\(/u);
	assert.doesNotMatch(repositorySession, /mode:\s*"(?:sync|remote)"/u);
	assert.match(repositorySession, /headers:\s*async/u);
	assert.match(repositorySession, /fetch:\s*createTelemetryFetch/u);

	const atelierPreview = await readFile(
		new URL("../../../vendor/atelier/preview/web/main.tsx", import.meta.url),
		"utf8",
	);
	assert.match(atelierPreview, /new OpfsStorage\(/u);
	assert.doesNotMatch(atelierPreview, /Storage[^\n]*from\s+"@lix-js\/sdk"/u);
});

async function sourceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const candidate = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(candidate)));
		else if (
			!entry.name.includes(".test.") &&
			/\.(?:ts|tsx)$/u.test(entry.name)
		) {
			files.push(candidate);
		}
	}
	return files;
}
