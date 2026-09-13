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
	assert.match(card.html, /gtm\/<\/span><span class="name">playbook\.md</);
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
	assert.ok(card.html.length < 24_000, `size ${card.html.length}`);
	// The trimmed body names its own gap, so the footer does not say it twice.
	assert.match(card.html, /⋯ \d+ unchanged lines/);
	assert.doesNotMatch(card.html, /more lines in LixRay/);
	// The change survives the trim; it is the unchanged bulk that goes.
	assert.match(card.html, /The new one/);
});

void test("a card too big for a thread keeps its header and drops the diff", () => {
	// Few enough lines to survive the trim, each long enough that the kept
	// window alone outgrows a message.
	const paragraph = "word ".repeat(1_200);
	const body = Array.from({ length: 12 }, () => paragraph).join("\n\n");
	const card = renderDiffCard({
		path: "/wide.md",
		url: URL_FOR("/wide.md"),
		beforeMarkdown: "",
		afterMarkdown: `${body}\n`,
	});

	assert.ok(card);
	assert.ok(card.html.length < 24_000, `size ${card.html.length}`);
	// The body is gone — only the stylesheet still mentions the marks.
	assert.doesNotMatch(
		card.html.slice(card.html.indexOf("<article")),
		/data-review-status/,
	);
	// What the reader is missing is the whole change, and the card says so.
	assert.equal(card.hidden, 12);
	assert.match(card.html, /12 more lines in LixRay/);
	assert.match(card.html, /Open in LixRay/);
});

void test("the size budget is bytes, not characters", () => {
	// A card of CJK text weighs three times what its length suggests.
	const line = "- " + "変更された行の説明です。".repeat(6);
	const body = Array.from({ length: 40 }, () => line).join("\n");
	const card = renderDiffCard({
		path: "/cjk.md",
		url: URL_FOR("/cjk.md"),
		beforeMarkdown: "",
		afterMarkdown: `${body}\n`,
	});

	assert.ok(card);
	assert.ok(
		new TextEncoder().encode(card.html).length <= 24_000,
		`bytes ${new TextEncoder().encode(card.html).length}`,
	);
});

void test("a document too large to card is left to the app", () => {
	// Rendering parses both sides, and the work scales with the document.
	const huge = `${"word ".repeat(30_000)}\n`;
	assert.equal(
		renderDiffCard({
			path: "/huge.md",
			url: URL_FOR("/huge.md"),
			beforeMarkdown: "",
			afterMarkdown: huge,
		}),
		null,
	);
});

void test("an overwrite of an empty file is not announced as a new file", () => {
	const card = renderDiffCard({
		path: "/notes.md",
		url: URL_FOR("/notes.md"),
		beforeMarkdown: "",
		afterMarkdown: "# Notes\n",
		existed: true,
	});

	assert.ok(card);
	assert.doesNotMatch(card.html, /new file/);
	assert.match(card.html, /\+1/);
});

void test("a one-line new file counts in the singular", () => {
	const card = renderDiffCard({
		path: "/one.md",
		url: URL_FOR("/one.md"),
		beforeMarkdown: "",
		afterMarkdown: "# One\n",
		existed: false,
	});

	assert.ok(card);
	assert.match(card.html, /new file · 1 line</);
});

void test("an image is named, never fetched", () => {
	const card = renderDiffCard({
		path: "/notes.md",
		url: URL_FOR("/notes.md"),
		beforeMarkdown: "Plain.\n",
		afterMarkdown: "Plain.\n\n![Funnel](https://tracker.example/p.gif)\n",
	});

	assert.ok(card);
	assert.doesNotMatch(card.html, /<img/);
	assert.doesNotMatch(card.html, /p\.gif/);
	assert.match(card.html, /Funnel/);
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

void test("a document nested past reading is left to the app", () => {
	// The parser walks nesting by recursion, and whoever opened the chat wrote
	// this document.
	for (const markdown of [
		`${">".repeat(200)} deep\n`,
		`${Array.from({ length: 120 }, (_, i) => `${" ".repeat(i * 2)}- item`).join("\n")}\n`,
	])
		assert.equal(
			renderDiffCard({
				path: "/deep.md",
				url: URL_FOR("/deep.md"),
				beforeMarkdown: "",
				afterMarkdown: markdown,
			}),
			null,
		);
});
