import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	cardTitle,
	commonFolder,
	countUnit,
	DIFF_CARD_STYLE,
	diffCardPayload,
	diffCardStatus,
	fileIconSvg,
	fileLabel,
	isRenderablePath,
	MAX_CARD_FILES,
	MAX_PREVIEWS,
	tallyLabel,
} from "./diff-card.ts";
import {
	DIFF_CARD_BAR_HEIGHT,
	DIFF_CARD_HTML,
	DIFF_CARD_META,
	DIFF_CARD_OPEN_HEIGHT,
	DIFF_CARD_URI,
	DIFF_GLYPH,
} from "./diff-card-app.ts";

const URL_FOR = (path: string) =>
	`https://lixray.com/@acme/company/file/IiIiIiIiQiKCIiIiIiIiIg${path}`;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const here = dirname(fileURLToPath(import.meta.url));

void test("a preview is offered for the files Atelier can draw", () => {
	for (const path of ["/README.md", "/gtm/plan.markdown", "/leads.csv"])
		assert.equal(isRenderablePath(path), true, path);
	for (const path of ["/logo.png", "/slides.pdf", "/Makefile"])
		assert.equal(isRenderablePath(path), false, path);
});

void test("the bar says how many, where, and what happened", () => {
	// One thing happened: the title says which, and the tally says nothing,
	// because a bar that says "1 file added · 1 added" says it twice.
	assert.equal(cardTitle(1, "written", ["added"]), "1 file added");
	assert.equal(
		cardTitle(3, "written", ["modified", "modified", "modified"]),
		"3 files modified",
	);
	assert.equal(cardTitle(1, "changed", ["moved"]), "1 file moved");
	assert.equal(
		cardTitle(2, "changed", ["removed", "removed"]),
		"2 files removed",
	);
	assert.equal(tallyLabel(["added"]), "");
	assert.equal(tallyLabel(["modified", "modified"]), "");
	// Several things did: the tool's own verb, and the tally breaks it down.
	assert.equal(cardTitle(1, "written"), "1 file written");
	assert.equal(cardTitle(3, "changed"), "3 files changed");
	assert.equal(
		cardTitle(2, "written", ["added", "modified"]),
		"2 files written",
	);
	assert.equal(
		commonFolder(["/gtm/campaigns/icp.md", "/gtm/campaigns/q3/plan.md"]),
		"/gtm/campaigns",
	);
	assert.equal(commonFolder(["/gtm/a.md", "/sales/b.md"]), "");
	assert.equal(commonFolder(["/README.md"]), "");
	assert.equal(commonFolder(["/docs/guide.md"]), "/docs");
	assert.equal(commonFolder([]), "");
	// Only what happened, in a fixed order.
	assert.equal(
		tallyLabel(["removed", "added", "modified", "added", "moved"]),
		"2 added · 1 modified · 1 moved · 1 removed",
	);
	assert.equal(tallyLabel(["modified", "added"]), "1 added · 1 modified");
});

void test("the footer's words follow the render's counts", () => {
	assert.equal(countUnit("/leads.csv"), "rows");
	assert.equal(countUnit("/notes.md"), "lines");
	assert.equal(
		fileLabel("added", { added: 5, modified: 0, removed: 0 }, "rows"),
		"added · 5 rows",
	);
	assert.equal(
		fileLabel("added", { added: 1, modified: 0, removed: 0 }, "rows"),
		"added · 1 row",
	);
	assert.equal(
		fileLabel("modified", { added: 12, modified: 0, removed: 3 }, "lines"),
		"modified · +12 −3 lines",
	);
	assert.equal(
		fileLabel("modified", { added: 1, modified: 2, removed: 0 }, "rows"),
		"modified · +1 ~2 rows",
	);
	assert.equal(
		fileLabel("removed", { added: 0, modified: 0, removed: 4 }, "lines"),
		"removed · 4 lines",
	);
	assert.equal(fileLabel("modified", undefined, "lines"), "modified");
	assert.equal(
		fileLabel("moved", undefined, "lines", { from: "/old/a.md", to: "/a.md" }),
		"moved from old/",
	);
	assert.equal(
		fileLabel("moved", undefined, "lines", {
			from: "/docs/a.md",
			to: "/docs/b.md",
		}),
		"moved from a.md",
	);
	assert.equal(
		fileLabel("moved", { added: 2, modified: 0, removed: 0 }, "lines", {
			from: "/a.md",
			to: "/docs/a.md",
		}),
		"moved from / · +2 lines",
	);
});

void test("a status per side, and a move when the path changed", () => {
	assert.equal(diffCardStatus({ after: bytes("a") }), "added");
	assert.equal(diffCardStatus({ before: bytes("a") }), "removed");
	assert.equal(
		diffCardStatus({ before: bytes("a"), after: bytes("b") }),
		"modified",
	);
	assert.equal(
		diffCardStatus({ before: bytes("a"), after: bytes("a"), movedFrom: "/x" }),
		"moved",
	);
});

void test("a card carries the change, the file, and the way back", () => {
	const card = diffCardPayload({
		verb: "written",
		repository: "@acme/company",
		changes: [
			{
				path: "/gtm/playbook.md",
				url: URL_FOR("/gtm/playbook.md"),
				before: bytes("## Experiments\n\n- [ ] Company brain\n"),
				after: bytes(
					"## Experiments\n\n- [ ] Company brain\n- [ ] AI consultants\n",
				),
			},
			{
				path: "/gtm/leads.csv",
				url: URL_FOR("/gtm/leads.csv"),
				after: bytes("name,stage\nAcme,lead\nBeta,lead\n"),
			},
			{
				path: "/gtm/old.md",
				url: "https://lixray.com/@acme/company",
				before: bytes("# Old\n\nOne paragraph.\n"),
			},
		],
	});

	assert.ok(card);
	assert.equal(card.title, "3 files written");
	assert.equal(card.folder, "/gtm");
	assert.equal(card.tally, "1 added · 1 modified · 1 removed");
	assert.equal(card.repository, "@acme/company");
	assert.equal(card.more, 0);
	const [edited, added, removed] = card.files;
	assert.equal(edited!.status, "modified");
	assert.equal(edited!.name, "playbook.md");
	assert.equal(edited!.label, "modified · +1 lines");
	assert.deepEqual(edited!.counts, { added: 1, modified: 0, removed: 0 });
	// Atelier's own view: the marks and the tokens that paint them.
	assert.match(edited!.html ?? "", /data-review-status="added"/);
	assert.match(edited!.html ?? "", /AI consultants/);
	assert.match(DIFF_CARD_STYLE, /--atelier-diff-added-subtle/);
	assert.equal(added!.status, "added");
	assert.equal(added!.label, "added · 3 rows");
	assert.match(added!.html ?? "", /<table>/);
	assert.equal(removed!.status, "removed");
	assert.equal(removed!.label, "removed · 2 lines");
	assert.equal(removed!.url, "https://lixray.com/@acme/company");
	// The file-type icon is Atelier's, inlined: nothing to fetch.
	for (const file of card.files) {
		assert.match(file.icon, /^<svg[\s\S]*<\/svg>$/);
		assert.doesNotMatch(file.icon, /<script/);
		assert.doesNotMatch(file.html ?? "", /<script|<link/);
	}
	assert.notEqual(edited!.icon, added!.icon);
});

void test("a change that draws nothing is still a page, with a note", () => {
	const card = diffCardPayload({
		verb: "changed",
		changes: [
			{
				path: "/logo.png",
				url: URL_FOR("/logo.png"),
				before: bytes("a"),
				after: bytes("b"),
			},
			{
				path: "/README.md",
				url: URL_FOR("/README.md"),
				before: bytes("# Acme\n"),
				after: bytes("# Acme\n"),
				movedFrom: "/docs/README.md",
			},
			{
				path: "/huge.md",
				url: URL_FOR("/huge.md"),
				after: bytes(`${"word ".repeat(30_000)}\n`),
			},
		],
	});
	assert.ok(card);
	assert.equal(card.title, "3 files changed");
	assert.equal(card.tally, "1 added · 1 modified · 1 moved");
	assert.equal(card.files[0]!.html, undefined);
	assert.match(card.files[0]!.note ?? "", /No preview for this file type/);
	assert.equal(card.files[1]!.status, "moved");
	assert.equal(card.files[1]!.label, "moved from docs/");
	assert.match(card.files[1]!.note ?? "", /content is unchanged/);
	assert.match(card.files[2]!.note ?? "", /Too much changed to show here/);
});

void test("a long change is trimmed, and the body says what is missing", () => {
	const before = Array.from({ length: 60 }, (_, i) => `- Item ${i + 1}`).join(
		"\n",
	);
	const card = diffCardPayload({
		verb: "written",
		changes: [
			{
				path: "/list.md",
				url: URL_FOR("/list.md"),
				before: bytes(`${before}\n`),
				after: bytes(`${before}\n- The new one\n`),
			},
		],
	});
	assert.ok(card);
	const [file] = card.files;
	assert.ok(byteLength(file!.html ?? "") <= 24_000);
	assert.match(file!.html ?? "", /⋯ \d+ unchanged lines/);
	assert.equal(file!.note, undefined);
	assert.match(file!.html ?? "", /The new one/);
});

void test("a long ledger comes back as a table, not as a refusal", () => {
	const rows = Array.from({ length: 600 }, (_, i) => `${i},acme,open`).join(
		"\n",
	);
	const before = `id,account,state\n${rows}\n`;
	const after = before.replace("300,acme,open", "300,acme,closed");
	const card = diffCardPayload({
		verb: "written",
		changes: [
			{
				path: "/gtm/leads.csv",
				url: URL_FOR("/gtm/leads.csv"),
				before: bytes(before),
				after: bytes(after),
			},
		],
	});
	assert.ok(card);
	const file = card.files[0]!;
	// The row that changed is in the card, the ones that did not are named
	// where they were, and nobody is told to go and look somewhere else.
	assert.ok(file.html);
	assert.match(file.html, /closed/);
	assert.match(file.html, /csv-diff-gap/);
	assert.match(file.html, /unchanged rows/);
	assert.equal(file.note, undefined);
	assert.match(file.label, /^modified/);
});

void test("previews stop at the budget; the list stops later; the count never", () => {
	const changes = Array.from({ length: MAX_CARD_FILES + 5 }, (_, i) => ({
		path: `/notes/${i}.md`,
		url: URL_FOR(`/notes/${i}.md`),
		after: bytes(`# Note ${i}\n`),
	}));
	const card = diffCardPayload({ verb: "written", changes });
	assert.ok(card);
	// Every one of them was created, the five the card could not list too.
	assert.equal(card.title, `${MAX_CARD_FILES + 5} files added`);
	assert.equal(card.tally, "");
	assert.equal(card.files.length, MAX_CARD_FILES);
	assert.equal(card.more, 5);
	assert.equal(
		card.files.filter((file) => file.html !== undefined).length,
		MAX_PREVIEWS,
	);
	assert.match(card.files[MAX_PREVIEWS]!.note ?? "", /Open it in LixRay/);
	assert.equal(diffCardPayload({ verb: "written", changes: [] }), null);
});

void test("content a writer controls cannot become markup in the card", () => {
	const card = diffCardPayload({
		verb: "written",
		repository: "<b>acme</b>",
		changes: [
			{
				path: "/<img src=x onerror=alert(1)>.md",
				url: 'https://lixray.com/"onload="alert(1)',
				before: bytes("ok\n"),
				after: bytes(
					"ok\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![p](https://tracker.example/p.gif)\n",
				),
			},
		],
	});
	assert.ok(card);
	const html = card.files[0]!.html ?? "";
	assert.doesNotMatch(html, /<script>alert/);
	assert.doesNotMatch(html, /javascript:/);
	// A picture is part of the change, so the card draws it — from the
	// address the document gives, escaped, and never as markup of its own.
	assert.match(html, /<img[^>]+src="https:\/\/tracker\.example\/p\.gif"/);
	assert.doesNotMatch(html, /onerror=/);
	// Names and repository travel as data; the view sets them as text.
	assert.equal(card.repository, "<b>acme</b>");
	assert.doesNotMatch(DIFF_CARD_HTML, /innerHTML/);
});

void test("the resource is one bar until opened, and draws Atelier's glyph", () => {
	assert.equal(DIFF_CARD_URI, "ui://lixray/diff-card/v1");
	assert.equal(DIFF_CARD_META, "lixray/diff-card");
	assert.equal(DIFF_CARD_BAR_HEIGHT, 44);
	// The bar is 42px inside a 1px border: 44 to the host, open or closed.
	assert.match(DIFF_CARD_HTML, /\.bar \{[^}]*height: 42px/);
	// Open, every card is the same height, whatever file it carries, and the
	// view sets that height on the document for a host that measures it.
	assert.equal(DIFF_CARD_OPEN_HEIGHT, 480);
	assert.match(DIFF_CARD_HTML, /\.card\.expanded \{ height: 480px; \}/);
	// "open" is the button that opens LixRay; the state class is not it.
	assert.doesNotMatch(DIFF_CARD_HTML, /\.card\.open\b/);
	assert.match(
		DIFF_CARD_HTML,
		/document\.documentElement\.style\.height = next \+ 'px'/,
	);
	// The chrome is a guest in someone else's chat and follows that chat's
	// scheme; the rendered file is Atelier, in Atelier's light one, which
	// the preview's shadow root inherits rather than pinning.
	assert.match(DIFF_CARD_HTML, /:root \{ color-scheme: light dark; \}/);
	assert.match(DIFF_CARD_HTML, /\.panel \{[^}]*color-scheme: light;/);
	assert.match(DIFF_CARD_HTML, /:host\{color-scheme:inherit\}/);
	// And a reader who wants the dark one takes it, for this card.
	assert.match(DIFF_CARD_HTML, /<button class="scheme" id="scheme"/);
	assert.match(DIFF_CARD_HTML, /Read this file in the dark scheme/);
	assert.match(DIFF_CARD_HTML, /Read this file in the light scheme/);
	assert.match(DIFF_CARD_HTML, /panel\.style\.setProperty\('color-scheme'/);
	assert.match(DIFF_CARD_HTML, /\.card \{[^}]*border: 1px solid/);
	assert.match(DIFF_CARD_HTML, /aria-expanded="false"/);
	assert.match(DIFF_CARD_HTML, /ui\/notifications\/size-changed/);
	assert.match(DIFF_CARD_HTML, /ui\/open-link/);
	assert.match(DIFF_CARD_HTML, /ui\/resource-teardown/);

	// Atelier's tokens are inlined once, and the chrome names no colour.
	assert.match(DIFF_CARD_HTML, /--atelier-overlay:/);
	assert.match(DIFF_CARD_HTML, /background: var\(--atelier-overlay\)/);
	assert.match(DIFF_CARD_HTML, /var\(--atelier-accent\)/);
	// The pill is dark chrome in either scheme, so its glyphs and its status
	// words take the overlay scale rather than the page's diff colours.
	for (const kind of ["added", "modified", "removed", "moved"])
		assert.match(
			DIFF_CARD_HTML,
			new RegExp(`--atelier-overlay-diff-${kind}\\)`),
		);
	// The glyph is the one Atelier draws, path for path.
	const geometry = readFileSync(
		join(here, "../../../vendor/atelier/src/components/diff-glyph-geometry.ts"),
		"utf8",
	);
	for (const [kind, path] of Object.entries(DIFF_GLYPH.knockout))
		assert.ok(geometry.includes(`${kind}: "${path}"`), kind);
	assert.match(geometry, /DIFF_GLYPH_RADIUS = 5;/);
	assert.match(geometry, /DIFF_GLYPH_STROKE = 1\.7;/);
	assert.match(DIFF_CARD_HTML, /<script>/);
	assert.doesNotMatch(DIFF_CARD_HTML, /<link|src="http/);
});

void test("the icon is decoded from Atelier's data URI whichever way it is encoded", () => {
	assert.match(fileIconSvg("/a.md"), /^<svg/);
	assert.match(fileIconSvg("/a.excalidraw"), /^<svg/);
	assert.match(fileIconSvg("/Makefile"), /^<svg/);
});

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}
