import assert from "node:assert/strict";
import test from "node:test";
import { isRenderablePath, renderDiffCard } from "./diff-card.ts";

const URL_FOR = (path: string) =>
	`https://lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg${path}`;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

void test("a card is offered for the files Atelier can draw", () => {
	for (const path of ["/README.md", "/gtm/plan.markdown", "/leads.csv"])
		assert.equal(isRenderablePath(path), true, path);
	for (const path of ["/logo.png", "/slides.pdf", "/Makefile"])
		assert.equal(isRenderablePath(path), false, path);
	assert.equal(
		renderDiffCard({
			path: "/logo.png",
			url: URL_FOR("/logo.png"),
			before: bytes("a"),
			after: bytes("b"),
		}),
		null,
	);
});

void test("a card carries the change, the file, and the way back", () => {
	const card = renderDiffCard({
		path: "/gtm/playbook.md",
		url: URL_FOR("/gtm/playbook.md"),
		before: bytes("## Experiments\n\n- [ ] Company brain\n"),
		after: bytes(
			"## Experiments\n\n- [ ] Company brain\n- [ ] AI consultants\n",
		),
		repository: "@acme/company",
	});

	assert.ok(card);
	assert.equal(card.kind, "modified");
	assert.deepEqual(card.counts, { added: 1, modified: 0, removed: 0 });
	assert.equal(card.hidden, 0);
	// Atelier's own view, inlined: the marks and the tokens that paint them.
	assert.match(card.html, /data-review-status="added"/);
	assert.match(card.html, /--atelier-diff-added-subtle/);
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

void test("a spreadsheet gets the same card, counted in rows", () => {
	const card = renderDiffCard({
		path: "/leads.csv",
		url: URL_FOR("/leads.csv"),
		before: bytes("name,stage\nAcme,lead\n"),
		after: bytes("name,stage\nAcme,qualified\nBeta,lead\n"),
		repository: "@acme/company",
	});

	assert.ok(card);
	assert.deepEqual(card.counts, { added: 1, modified: 1, removed: 0 });
	assert.match(card.html, /<table>/);
	assert.match(card.html, /qualified/);
	assert.match(card.html, /Open in LixRay/);
});

void test("which side is missing says what happened", () => {
	const created = renderDiffCard({
		path: "/README.md",
		url: URL_FOR("/README.md"),
		after: bytes("# Acme\n\nOne company. One repository.\n"),
	});
	assert.ok(created);
	assert.equal(created.kind, "added");
	assert.match(created.html, /new file · 2 entries/);
	assert.match(created.html, /--atelier-diff-added/);

	// An empty file that existed is an overwrite, not a new file.
	const overwritten = renderDiffCard({
		path: "/README.md",
		url: URL_FOR("/README.md"),
		before: bytes(""),
		after: bytes("# Acme\n"),
	});
	assert.ok(overwritten);
	assert.equal(overwritten.kind, "modified");
	assert.doesNotMatch(overwritten.html, /new file/);
});

void test("a write that changes nothing gets no card", () => {
	assert.equal(
		renderDiffCard({
			path: "/README.md",
			url: URL_FOR("/README.md"),
			before: bytes("# Acme\n"),
			after: bytes("# Acme\n"),
		}),
		null,
	);
});

void test("a long change is trimmed, and the body says what is missing", () => {
	const before = Array.from({ length: 60 }, (_, i) => `- Item ${i + 1}`).join(
		"\n",
	);
	const card = renderDiffCard({
		path: "/list.md",
		url: URL_FOR("/list.md"),
		before: bytes(`${before}\n`),
		after: bytes(`${before}\n- The new one\n`),
	});

	assert.ok(card);
	assert.ok(card.hidden > 30, `hidden ${card.hidden}`);
	assert.ok(byteLength(card.html) <= 24_000, `size ${byteLength(card.html)}`);
	assert.match(card.html, /⋯ \d+ unchanged lines/);
	assert.doesNotMatch(card.html, /more entries in LixRay/);
	assert.match(card.html, /The new one/);
});

void test("a card too big for a thread keeps its header and drops the view", () => {
	// Few enough lines to survive the trim, each long enough that the kept
	// window alone outgrows a message.
	const paragraph = "word ".repeat(1_200);
	const body = Array.from({ length: 12 }, () => paragraph).join("\n\n");
	const card = renderDiffCard({
		path: "/wide.md",
		url: URL_FOR("/wide.md"),
		after: bytes(`${body}\n`),
	});

	assert.ok(card);
	assert.ok(byteLength(card.html) <= 24_000, `size ${byteLength(card.html)}`);
	assert.doesNotMatch(
		card.html.slice(card.html.indexOf("<article")),
		/data-review-status/,
	);
	assert.match(card.html, /Too much changed to show here/);
	assert.match(card.html, /Open in LixRay/);
});

void test("the budget is bytes, not characters", () => {
	const line = `- ${"変更された行の説明です。".repeat(6)}`;
	const body = Array.from({ length: 40 }, () => line).join("\n");
	const card = renderDiffCard({
		path: "/cjk.md",
		url: URL_FOR("/cjk.md"),
		after: bytes(`${body}\n`),
	});

	assert.ok(card);
	assert.ok(byteLength(card.html) <= 24_000, `bytes ${byteLength(card.html)}`);
});

void test("a document too large to draw still gets its name and its link", () => {
	// Rendering is declined — the file is a megabyte, or nested past reading —
	// but the reader is still told which file changed and where to see it.
	for (const after of [
		bytes(`${"word ".repeat(30_000)}\n`),
		bytes(`${">".repeat(200)} deep\n`),
	]) {
		const card = renderDiffCard({
			path: "/huge.md",
			url: URL_FOR("/huge.md"),
			after,
		});
		assert.ok(card);
		assert.match(card.html, /huge\.md/);
		assert.match(card.html, /Too much changed to show here/);
		assert.match(card.html, /Open in LixRay/);
		assert.ok(byteLength(card.html) <= 24_000);
	}
});

void test("content a writer controls cannot become markup in the card", () => {
	const card = renderDiffCard({
		path: "/<img src=x onerror=alert(1)>.md",
		url: 'https://lixray.com/"onload="alert(1)',
		before: bytes("ok\n"),
		after: bytes(
			"ok\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![p](https://tracker.example/p.gif)\n",
		),
		repository: "<b>acme</b>",
	});

	assert.ok(card);
	assert.doesNotMatch(card.html, /<script>alert/);
	assert.doesNotMatch(card.html, /javascript:/);
	assert.doesNotMatch(card.html, /<b>acme/);
	assert.doesNotMatch(card.html, /onerror=alert\(1\)>/);
	assert.doesNotMatch(card.html, /"onload="/);
	// An image address is the document author's; the card names it, never
	// asks the reader's client to fetch it.
	assert.doesNotMatch(card.html, /<img/);
	assert.doesNotMatch(card.html, /p\.gif/);
});

void test("a diff that fits the card is shown, not summarised away", () => {
	// The frame carries the whole stylesheet. Guessing its size sent
	// mid-sized diffs — the common case — to a bare link.
	const line = `- ${"word ".repeat(140)}`;
	const before = Array.from({ length: 30 }, () => line).join("\n");
	const after = before.replace("word word word", "word CHANGED word");
	const card = renderDiffCard({
		path: "/CHANGELOG.md",
		url: URL_FOR("/CHANGELOG.md"),
		before: bytes(`${before}\n`),
		after: bytes(`${after}\n`),
	});

	assert.ok(card);
	assert.match(card.html, /class="body"/);
	assert.match(card.html, /CHANGED/);
	assert.ok(byteLength(card.html) <= 24_000, `size ${byteLength(card.html)}`);
});

void test("a path no header could show still makes a card that fits", () => {
	const card = renderDiffCard({
		path: `/docs/${"n".repeat(5_600)}.md`,
		url: URL_FOR("/docs/long.md"),
		after: bytes("# Hi\n"),
	});

	assert.ok(card);
	assert.ok(byteLength(card.html) <= 24_000, `size ${byteLength(card.html)}`);
	// The tail identifies the file; the ellipsis goes in the middle.
	assert.match(card.html, /…/);
});

void test("a deleted file reads as deleted", () => {
	const card = renderDiffCard({
		path: "/old.md",
		url: URL_FOR("/old.md"),
		before: bytes("# Old\n\nOne paragraph.\n"),
	});

	assert.ok(card);
	assert.equal(card.kind, "removed");
	assert.match(card.html, /deleted · 2 entries/);
});

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}
