import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderDocsMarkdown } from "./docs-markdown.ts";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../docs");

function readDocs(name: string): string {
	return readFileSync(join(docsDir, name), "utf8");
}

void test("legal docs name Opral US Inc. and Delaware law", () => {
	const privacy = readDocs("privacy.md");
	const terms = readDocs("terms.md");
	const toc = JSON.parse(readDocs("table_of_content.json")) as Record<
		string,
		{ path: string; label: string }[]
	>;

	assert.match(
		privacy,
		/This policy describes how \*\*Opral US Inc\.\*\* \(“we”\) handles personal data/,
	);
	assert.match(
		terms,
		/These terms are a contract between \*\*Opral US Inc\.\*\* \(“we”\) and you/,
	);
	assert.match(
		terms,
		/LixRay is provided \*\*AS IS\*\* and \*\*AS AVAILABLE\*\*/,
	);
	assert.match(
		terms,
		/the greater of \*\*\$100\*\* or the fees you paid us for LixRay/,
	);
	assert.match(
		terms,
		/Delaware law governs, without regard to conflict-of-law rules/,
	);
	assert.match(
		terms,
		/The state and federal courts in Delaware have exclusive jurisdiction/,
	);
	assert.doesNotMatch(
		terms,
		/Common Paper|cover page|Cloud Service Agreement|Provider Covered Claims/,
	);

	for (const [name, text] of [
		["privacy.md", privacy],
		["terms.md", terms],
	] as const) {
		assert.doesNotMatch(text, /Germany|Berlin|GmbH|€/, name);
		assert.doesNotMatch(text, /(?<!US Inc\.)\bOpral\b(?! US Inc\.)/, name);
	}

	assert.equal(toc.Legal, undefined);
	assert.deepEqual(
		Object.values(toc).flatMap((items) => items.map((item) => item.path)),
		["what-is-lixray.md", "mcp.md"],
	);

	assert.match(
		renderDocsMarkdown(privacy).html,
		/<h1 id="lixray-privacy-policy">LixRay Privacy Policy/,
	);
	assert.match(
		renderDocsMarkdown(terms).html,
		/<h1 id="lixray-terms-of-service">LixRay Terms of Service/,
	);
});
