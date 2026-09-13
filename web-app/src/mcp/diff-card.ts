import {
	MARKDOWN_DIFF_CSS,
	renderMarkdownDiff,
	type MarkdownDiffStats,
} from "@opral/atelier/markdown-diff";

/**
 * The card a write sends back to the chat.
 *
 * A tool result says a file changed; the change itself is what the reader
 * wants, and it used to live one navigation away. This renders it inline,
 * in Atelier's own review UI — the same document builder, the same marks,
 * the same palette the app and the review float draw — as one self-contained
 * HTML document with no scripts and nothing to fetch.
 */

/** Files the diff renderer understands. Others get their link, as before. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/** Cards past this size stop being a card; the reader is sent to the app. */
const MAX_CARD_BYTES = 24_000;

export type DiffCardInput = {
	readonly path: string;
	readonly url: string;
	readonly beforeMarkdown: string;
	readonly afterMarkdown: string;
	/** "@opral/monorepo", shown as the card's quiet second line. */
	readonly repository?: string;
};

export type DiffCard = {
	readonly html: string;
	readonly stats: MarkdownDiffStats;
	/** Lines the card left out because of its height budget. */
	readonly hidden: number;
};

export function isMarkdownPath(path: string): boolean {
	const name = path.split("/").filter(Boolean).at(-1) ?? "";
	const extension = name.includes(".")
		? name.split(".").at(-1)?.toLowerCase()
		: undefined;
	return extension !== undefined && MARKDOWN_EXTENSIONS.has(extension);
}

export function renderDiffCard(input: DiffCardInput): DiffCard | null {
	if (!isMarkdownPath(input.path)) return null;
	const diff = renderMarkdownDiff({
		beforeMarkdown: input.beforeMarkdown,
		afterMarkdown: input.afterMarkdown,
		context: 1,
		maxLines: 12,
	});
	if (diff.unchanged) return null;
	const created = input.beforeMarkdown === "";
	const body = cardDocument({
		...input,
		diffHtml: diff.html,
		stats: diff.stats,
		hidden: diff.hidden,
		created,
	});
	if (body.length <= MAX_CARD_BYTES)
		return { html: body, stats: diff.stats, hidden: diff.hidden };
	// Too big to read in a thread anyway: keep the header, drop the diff.
	return {
		html: cardDocument({
			...input,
			diffHtml: "",
			stats: diff.stats,
			hidden: diff.hidden + countLines(diff.html),
			created,
		}),
		stats: diff.stats,
		hidden: diff.hidden,
	};
}

function countLines(html: string): number {
	return (html.match(/<(?:li|p|h[1-6]|tr|pre)\b/g) ?? []).length;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function statsLabel(stats: MarkdownDiffStats, created: boolean): string {
	if (created) return `new file · ${stats.added} lines`;
	const parts: string[] = [];
	if (stats.added > 0) parts.push(`<span class="plus">+${stats.added}</span>`);
	if (stats.removed > 0)
		parts.push(`<span class="minus">−${stats.removed}</span>`);
	if (stats.modified > 0)
		parts.push(`<span class="edited">${stats.modified} edited</span>`);
	return parts.join(" · ") || "no change";
}

/** The dot-hybrid glyph Atelier draws beside a changed file. */
function glyph(created: boolean): string {
	const fill = created ? "rgb(21,128,61)" : "rgb(234,88,12)";
	const knockout = created
		? "M6 3.6v4.8M3.6 6h4.8"
		: "M3.3 6.3c.9-1.5 1.8-1.5 2.7 0s1.8 1.5 2.7 0";
	return `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${fill}"></circle><path d="${knockout}" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function cardDocument(args: {
	readonly path: string;
	readonly url: string;
	readonly repository?: string;
	readonly diffHtml: string;
	readonly stats: MarkdownDiffStats;
	readonly hidden: number;
	readonly created: boolean;
}): string {
	const segments = args.path.split("/").filter(Boolean);
	const name = segments.at(-1) ?? args.path;
	const directory = segments.slice(0, -1).join("/");
	const hiddenNote =
		args.hidden > 0
			? `<div class="rest">${args.hidden} more ${args.hidden === 1 ? "line" : "lines"} in LixRay</div>`
			: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
${CARD_CSS}
${MARKDOWN_DIFF_CSS}
</style>
</head>
<body>
<article class="card">
	<header>
		${glyph(args.created)}
		<span class="path">${directory ? `<span class="dir">${escapeHtml(directory)}/</span>` : ""}${escapeHtml(name)}</span>
		<span class="counts">${statsLabel(args.stats, args.created)}</span>
	</header>
	${args.diffHtml ? `<div class="md-diff">${args.diffHtml}</div>` : ""}
	${hiddenNote}
	<footer>
		<span class="repo">${args.repository ? escapeHtml(args.repository) : ""}</span>
		<a class="open" href="${escapeHtml(args.url)}" target="_blank" rel="noreferrer noopener">Open in LixRay</a>
	</footer>
</article>
</body>
</html>`;
}

/** The card's own chrome: Atelier's neutrals, sized for a message. */
const CARD_CSS = `
:root { color-scheme: light; }
body {
	margin: 0;
	padding: 0;
	background: transparent;
	font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	color: rgb(28, 25, 23);
}
.card {
	border: 1px solid rgb(236, 232, 226);
	border-radius: 12px;
	background: #fff;
	overflow: hidden;
}
.card > header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 11px 13px;
	border-bottom: 1px solid rgb(244, 241, 236);
}
.card > header .path {
	flex: 1;
	min-width: 0;
	font-size: 13px;
	font-weight: 500;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card > header .dir { color: rgb(168, 162, 158); font-weight: 400; }
.card > header .counts {
	flex: none;
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	color: rgb(120, 113, 108);
}
.card > header .plus { color: rgb(22, 101, 52); }
.card > header .minus { color: rgb(153, 27, 27); }
.card > header .edited { color: rgb(120, 113, 108); }
.card .md-diff { padding: 12px 14px 14px; }
.card .rest {
	padding: 0 14px 12px;
	font-size: 12px;
	color: rgb(168, 162, 158);
}
.card > footer {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 13px;
	border-top: 1px solid rgb(244, 241, 236);
	background: rgb(250, 250, 249);
}
.card > footer .repo {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	color: rgb(168, 162, 158);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card > footer .open {
	flex: none;
	padding: 6px 11px;
	border-radius: 7px;
	background: rgb(194, 65, 12);
	color: #fff;
	font-size: 12px;
	font-weight: 500;
	text-decoration: none;
}
`;
