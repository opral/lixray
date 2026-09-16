import { isRendered, RENDER_CSS, toHtml } from "@opral/atelier/render";
import type { RenderCounts, RenderKind } from "@opral/atelier/render";

/**
 * The card a write sends back to the chat.
 *
 * A tool result says a file changed; the change itself is what the reader
 * wants, and it used to live one navigation away. Atelier renders the file —
 * whichever view claims it, in the app's own review UI — and this wraps that
 * in the chrome a message needs: which file, how much changed, and the way
 * back. One self-contained document, no scripts and nothing to fetch.
 */

/** Cards past this size stop being a card; the reader is sent to the app. */
const MAX_CARD_BYTES = 24_000;

/**
 * Atelier's stylesheet, whitespace collapsed outside quoted strings. It is
 * written for reading, and inlined in every card it would spend a fifth of
 * the budget on indentation.
 */
function compactCss(css: string): string {
	let out = "";
	let quote: string | null = null;
	let space = false;
	for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
		if (quote) {
			out += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			out += char;
			continue;
		}
		if (/\s/.test(char)) {
			space = true;
			continue;
		}
		if (space && !/[{}:;,>)]/.test(char) && !/[{}:;,>(]$/.test(out)) out += " ";
		space = false;
		out += char;
	}
	return out.replaceAll(";}", "}");
}
// Atelier's build prunes render/styles.d.ts, the declaration behind RENDER_CSS,
// so the import has no type until scripts/prune-types.mjs keeps it.
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const STYLE = compactCss(RENDER_CSS);

export type DiffCardInput = {
	readonly path: string;
	readonly url: string;
	readonly before?: Uint8Array;
	readonly after?: Uint8Array;
	/** "@opral/monorepo", shown as the card's quiet second line. */
	readonly repository?: string;
};

export type DiffCard = {
	readonly html: string;
	readonly counts?: RenderCounts;
	readonly kind: RenderKind;
	/** Entities the card left out because of its height budget. */
	readonly hidden: number;
};

/** Whether Atelier has a static view for this path, without rendering it. */
export function isRenderablePath(path: string): boolean {
	const probe = toHtml({ path, after: new Uint8Array([0x20]) });
	return !(!isRendered(probe) && probe.skipped === "unsupported");
}

export function renderDiffCard(input: DiffCardInput): DiffCard | null {
	const content = {
		path: input.path,
		...(input.before !== undefined ? { before: input.before } : {}),
		...(input.after !== undefined ? { after: input.after } : {}),
	};
	// The stylesheet is most of the chrome; the header and footer take about
	// 1 kB more, and the view gets the rest.
	const view = toHtml(content, {
		maxBytes: MAX_CARD_BYTES - byteLength(STYLE) - 1_000,
	});
	if (!isRendered(view)) {
		// A change too big to read in a thread is still a change worth
		// announcing: the header says which file, the footer leads to it.
		if (view.skipped !== "too-large") return null;
		const kind: RenderKind =
			input.before === undefined
				? "added"
				: input.after === undefined
					? "removed"
					: "modified";
		return {
			html: cardDocument({
				...input,
				viewHtml: "",
				kind,
				hidden: 0,
				tooLarge: true,
			}),
			kind,
			hidden: 0,
		};
	}
	const body = cardDocument({
		...input,
		viewHtml: view.html,
		counts: view.counts,
		kind: view.kind,
		hidden: view.hidden,
	});
	if (byteLength(body) <= MAX_CARD_BYTES)
		return {
			html: body,
			kind: view.kind,
			hidden: view.hidden,
			...(view.counts ? { counts: view.counts } : {}),
		};
	// The view fitted its own budget and the whole card still did not: keep
	// the header, drop the view, and say so rather than counting again.
	return {
		html: cardDocument({
			...input,
			viewHtml: "",
			...(view.counts ? { counts: view.counts } : {}),
			kind: view.kind,
			hidden: view.hidden,
			tooLarge: true,
		}),
		kind: view.kind,
		hidden: view.hidden,
		...(view.counts ? { counts: view.counts } : {}),
	};
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function countsLabel(
	counts: RenderCounts | undefined,
	kind: RenderKind,
): string {
	if (!counts) return kind === "added" ? "new file" : "";
	if (kind === "added")
		return `new file · ${counts.added} ${counts.added === 1 ? "entry" : "entries"}`;
	if (kind === "removed" && counts.removed > 0 && counts.added === 0)
		return `deleted · ${counts.removed} ${counts.removed === 1 ? "entry" : "entries"}`;
	const parts: string[] = [];
	if (counts.added > 0)
		parts.push(`<span class="plus">+${counts.added}</span>`);
	if (counts.removed > 0)
		parts.push(`<span class="minus">−${counts.removed}</span>`);
	if (counts.modified > 0)
		parts.push(`<span class="edited">${counts.modified} edited</span>`);
	return parts.join(" · ") || "no change";
}

/** The dot-hybrid glyph Atelier draws beside a changed file. */
function glyph(kind: RenderKind): string {
	const fill =
		kind === "added"
			? "var(--atelier-diff-added)"
			: kind === "removed"
				? "var(--atelier-diff-removed)"
				: "var(--atelier-link)";
	const knockout =
		kind === "added"
			? "M6 3.6v4.8M3.6 6h4.8"
			: kind === "removed"
				? "M3.6 6h4.8"
				: "M3.3 6.3c.9-1.5 1.8-1.5 2.7 0s1.8 1.5 2.7 0";
	return `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${fill}"></circle><path d="${knockout}" stroke="var(--atelier-panel)" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function cardDocument(args: {
	readonly path: string;
	readonly url: string;
	readonly repository?: string;
	readonly viewHtml: string;
	readonly counts?: RenderCounts;
	readonly kind: RenderKind;
	readonly hidden: number;
	/** The change does not fit a message; the card is header and link only. */
	readonly tooLarge?: boolean;
}): string {
	const segments = args.path.split("/").filter(Boolean);
	const name = clip(segments.at(-1) ?? args.path, 64);
	const directory = clipDirectory(segments.slice(0, -1));
	// The trimmed body names its own gaps; saying it again reads as a second
	// set of missing lines.
	const hiddenNote = args.tooLarge
		? `<div class="rest">Too much changed to show here — open it in LixRay</div>`
		: args.hidden > 0 && !args.viewHtml.includes("md-diff-gap")
			? `<div class="rest">${args.hidden} more ${args.hidden === 1 ? "entry" : "entries"} in LixRay</div>`
			: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
${STYLE}
${CARD_CSS}
</style>
</head>
<body>
<article class="card atelier-render">
	<header>
		${glyph(args.kind)}
		<span class="path">${directory ? `<span class="dir">${escapeHtml(directory)}/</span>` : ""}<span class="name">${escapeHtml(name)}</span></span>
		<span class="counts">${args.tooLarge ? "too large" : countsLabel(args.counts, args.kind)}</span>
	</header>
	${args.viewHtml ? `<div class="body">${args.viewHtml}</div>` : ""}
	${hiddenNote}
	<footer>
		<span class="repo">${args.repository ? escapeHtml(args.repository) : ""}</span>
		<a class="open" href="${escapeHtml(args.url)}" target="_blank" rel="noreferrer noopener">Open in LixRay</a>
	</footer>
</article>
</body>
</html>`;
}

/**
 * A path's last two folders, which is what tells a reader where they are.
 * Trimming the tail with an ellipsis would keep the half that does not.
 */
function clipDirectory(segments: readonly string[]): string {
	if (segments.length === 0) return "";
	const tail = segments.slice(-2).map((segment) => clip(segment, 24));
	return `${segments.length > 2 ? "…/" : ""}${tail.join("/")}`;
}

/** A name longer than this is not a name a header can show. */
function clip(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** The card's own chrome. Atelier owns the view; LixRay owns the frame. */
const CARD_CSS = `
:root { color-scheme: light; }
body { margin: 0; padding: 0; background: transparent; }
.card {
	border: 1px solid var(--atelier-border);
	border-radius: 12px;
	background: var(--atelier-panel);
	overflow: hidden;
}
.card > header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 11px 13px;
	border-bottom: 1px solid var(--atelier-border-subtle);
}
.card > header .path {
	display: flex;
	flex: 1;
	min-width: 0;
	overflow: hidden;
	font-size: 13px;
	font-weight: 500;
}
.card > header .dir {
	flex: 0 1 auto;
	min-width: 0;
	color: var(--atelier-fg-subtle);
	font-weight: 400;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card > header .name {
	flex: 0 1 auto;
	min-width: 0;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card > header .counts {
	flex: none;
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	color: var(--atelier-fg-subtle);
}
.card > header .plus { color: var(--atelier-diff-added); }
.card > header .minus { color: var(--atelier-diff-removed); }
.card .body { padding: 12px 14px 14px; }
.card > header + .rest { padding-top: 10px; }
.card .rest {
	padding: 0 14px 12px;
	font-size: 13px;
	color: var(--atelier-fg-muted);
}
.card > footer {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 13px;
	border-top: 1px solid var(--atelier-border-subtle);
	background: var(--atelier-bg-subtle);
}
.card > footer .repo {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	color: var(--atelier-fg-subtle);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card > footer .open {
	flex: none;
	padding: 6px 11px;
	border-radius: 7px;
	background: var(--atelier-accent);
	color: var(--atelier-panel);
	font-size: 12px;
	font-weight: 500;
	text-decoration: none;
}
`;
