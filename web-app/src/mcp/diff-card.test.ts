import assert from "node:assert/strict";
import test from "node:test";
import { isMarkdownPath, renderDiffCard } from "./diff-card.ts";

const URL_FOR = (path: string) =>
	`https://lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg${path}`;

void test("only the files the renderer understands get a card", () => {
	for (const path of ["/README.md", "/gtm/plan.markdown", "/notes.mdx"])
		assert.equal(isMarkdownPath(path), true, path);
	for (const path of ["/data.csv", "/logo.png", "/Makefile", "/a.md.bak"])
		assert.equal(isMarkdownPath(path), false, path);
	assert.equal(
		renderDiffCard({
			path: "/data.csv",
			url: URL_FOR("/data.csv"),
			beforeMarkdown: "a",
			afterMarkdown: "b",
		}),
		null,
	);
});

void test("a card carries the change, the file, and the way back", () => {
	const card = renderDiffCard({
		path: "/gtm/playbook.md",
		url: URL_FOR("/gtm/playbook.md"),
		beforeMarkdown: "## Experiments\n\n- [ ] Company brain\n",
		afterMarkdown:
			"## Experiments\n\n- [ ] Company brain\n- [ ] AI consultants\n",
		repository: "@acme/company",
	});

	assert.ok(card);
	assert.deepEqual(card.stats, { added: 1, removed: 0, modified: 0 });
	assert.equal(card.hidden, 0);
	// Atelier's review UI, inlined: the marks and the stylesheet that paints them.
	assert.match(card.html, /data-review-status="added"/);
	assert.match(card.html, /\.md-diff/);
	assert.match(card.html, /AI consultants/);
	// The header names the file, the footer leads back to it.
	assert.match(card.html, /gtm\/<\/span>playbook\.md/);
	assert.match(card.html, /\+1/);
	assert.match(card.html, /@acme\/company/);
	assert.match(
		card.html,
		/href="https:\/\/lixray\.com\/@acme\/company\/file\//,
	);
	assert.match(card.html, /Open in LixRay/);
	// Nothing to run and nothing to fetch: a card is a document, not a page.
	assert.doesNotMatch(card.html, /<script/);
	assert.doesNotMatch(card.html, /<link/);
});

void test("a new file reads as a new file, not as a wall of additions", () => {
	const card = renderDiffCard({
		path: "/README.md",
		url: URL_FOR("/README.md"),
		beforeMarkdown: "",
		afterMarkdown: "# Acme\n\nOne company. One repository.\n",
	});

	assert.ok(card);
	assert.match(card.html, /new file · 2 lines/);
	assert.match(card.html, /rgb\(21,128,61\)/);
});

void test("a write that changes nothing gets no card", () => {
	assert.equal(
		renderDiffCard({
			path: "/README.md",
			url: URL_FOR("/README.md"),
			beforeMarkdown: "# Acme\n",
			afterMarkdown: "# Acme\n",
		}),
		null,
	);
});

void test("a long change is trimmed, and the card says how much is missing", () => {
	const before = Array.from({ length: 60 }, (_, i) => `- Item ${i + 1}`).join(
		"\n",
	);
	const card = renderDiffCard({
		path: "/list.md",
		url: URL_FOR("/list.md"),
		beforeMarkdown: `${before}\n`,
		afterMarkdown: `${before}\n- The new one\n`,
	});

	assert.ok(card);
	assert.ok(card.hidden > 30, `hidden ${card.hidden}`);
	assert.match(card.html, /more lines in LixRay/);
	assert.ok(card.html.length < 24_000, `size ${card.html.length}`);
});

void test("a card too big for a thread keeps its header and drops the diff", () => {
	const line = "- " + "word ".repeat(40);
	const body = Array.from({ length: 400 }, () => line).join("\n");
	const card = renderDiffCard({
		path: "/huge.md",
		url: URL_FOR("/huge.md"),
		beforeMarkdown: "",
		afterMarkdown: `${body}\n`,
	});

	assert.ok(card);
	assert.ok(card.html.length < 24_000, `size ${card.html.length}`);
	assert.match(card.html, /more lines in LixRay/);
	assert.match(card.html, /Open in LixRay/);
});

void test("content a writer controls cannot become markup in the card", () => {
	const card = renderDiffCard({
		path: "/<img src=x onerror=alert(1)>.md",
		url: 'https://lixray.com/"onload="alert(1)',
		beforeMarkdown: "ok\n",
		afterMarkdown:
			"ok\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n",
		repository: "<b>acme</b>",
	});

	assert.ok(card);
	assert.doesNotMatch(card.html, /<script/);
	assert.doesNotMatch(card.html, /javascript:/);
	assert.doesNotMatch(card.html, /<b>acme/);
	assert.doesNotMatch(card.html, /onerror=alert\(1\)>/);
	assert.doesNotMatch(card.html, /"onload="/);
});
