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
		/This Agreement is between \*\*Opral US Inc\.\*\* \(“Provider”\)/,
	);
	assert.match(terms, /\*\*Provider\.\*\* Opral US Inc\./);
	assert.match(
		terms,
		/\*\*Governing Law\.\*\* the State of Delaware, United States/,
	);
	assert.match(
		terms,
		/\*\*Chosen Courts\.\*\* the state and federal courts located in the State of Delaware/,
	);
	assert.match(
		terms,
		/\*\*General Cap Amount\.\*\* The greater of \$100 or the fees paid or payable/,
	);

	for (const [name, text] of [
		["privacy.md", privacy],
		["terms.md", terms],
	] as const) {
		assert.doesNotMatch(text, /Germany|Berlin|GmbH|€/, name);
		assert.doesNotMatch(text, /(?<!US Inc\.)\bOpral\b(?! US Inc\.)/, name);
	}

	assert.deepEqual(toc.Legal, [
		{ path: "privacy.md", label: "Privacy Policy" },
		{ path: "terms.md", label: "Terms of Service" },
	]);

	assert.match(
		renderDocsMarkdown(privacy).html,
		/<h1 id="lixray-privacy-policy">LixRay Privacy Policy/,
	);
	assert.match(
		renderDocsMarkdown(terms).html,
		/<h1 id="lixray-terms-of-service">LixRay Terms of Service/,
	);
});
