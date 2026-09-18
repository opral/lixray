import { fileIconUrl } from "@opral/atelier/file-icons";
import { isRendered, RENDER_CSS, toHtml } from "@opral/atelier/render";
import type { RenderCounts } from "@opral/atelier/render";
import { base64ToBytes } from "../lib/base64.ts";

/**
 * The card a change sends back to the chat.
 *
 * A tool result says files changed; the change itself is what the reader
 * wants, and it used to live one navigation away. Atelier renders each file
 * — whichever view claims it, in the app's own review UI — and this collects
 * those renders with the words the card's bar and footer say: how many
 * files, where they sit, what happened to each. The card's chrome lives in
 * the static MCP Apps resource; this is the data it shows. Nothing here runs
 * in the reader's browser, and nothing here fetches.
 */

/** A preview past this size stops being a preview; the reader is sent to the app. */
const MAX_PREVIEW_BYTES = 24_000;

/** How many files a single card carries a preview for. */
export const MAX_PREVIEWS = 6;

/** How many files a single card lists at all. */
export const MAX_CARD_FILES = 50;

/**
 * Atelier's stylesheet, whitespace collapsed outside quoted strings. It is
 * written for reading, and inlined in the resource it would spend a fifth of
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

/** Atelier's tokens and view styles, for the resource and every preview. */
export const DIFF_CARD_STYLE = compactCss(RENDER_CSS);

export type DiffCardStatus = "added" | "modified" | "removed" | "moved";

/** One changed file, as the card lists it. */
export type DiffCardChange = {
	readonly path: string;
	/** The path at the span's start, when the file moved. */
	readonly movedFrom?: string;
	readonly url: string;
	readonly before?: Uint8Array;
	readonly after?: Uint8Array;
};

export type DiffCardFile = {
	readonly path: string;
	readonly name: string;
	readonly status: DiffCardStatus;
	/** "edited · +12 −3 rows": the footer's muted words. */
	readonly label: string;
	readonly url: string;
	/** The file-type icon, inline SVG markup. */
	readonly icon: string;
	/** Atelier's view of the change, for an element with class atelier-render. */
	readonly html?: string;
	/** What stands in for the view, or follows it, when it does not say everything. */
	readonly note?: string;
	readonly counts?: RenderCounts;
};

/** What travels in `_meta` beside a result: the card's bar and its pages. */
export type DiffCardPayload = {
	/** "1 file added", or "3 files written" when they did several things. */
	readonly title: string;
	/** The deepest folder every file is under; absent at the root. */
	readonly folder?: string;
	/** "2 added · 1 modified", or "" when the title already said it. */
	readonly tally: string;
	/** "@opral/monorepo" */
	readonly repository?: string;
	readonly files: ReadonlyArray<DiffCardFile>;
	/** Files the card could not list; the bar's count includes them. */
	readonly more: number;
};

/** Whether Atelier has a static view for this path, without rendering it. */
export function isRenderablePath(path: string): boolean {
	const probe = toHtml({ path, after: new Uint8Array([0x20]) });
	return !(!isRendered(probe) && probe.skipped === "unsupported");
}

export function diffCardStatus(change: {
	readonly movedFrom?: string;
	readonly before?: Uint8Array;
	readonly after?: Uint8Array;
}): DiffCardStatus {
	if (change.before === undefined) return "added";
	if (change.after === undefined) return "removed";
	return change.movedFrom !== undefined ? "moved" : "modified";
}

/**
 * The deepest directory every path is under, or "" at the root. One file
 * is under its own folder.
 */
export function commonFolder(paths: ReadonlyArray<string>): string {
	if (paths.length === 0) return "";
	let common: string[] | undefined;
	for (const path of paths) {
		const segments = path.split("/").filter(Boolean).slice(0, -1);
		if (!common) {
			common = segments;
			continue;
		}
		let shared = 0;
		while (
			shared < common.length &&
			shared < segments.length &&
			common[shared] === segments[shared]
		)
			shared += 1;
		common = common.slice(0, shared);
	}
	return common && common.length > 0 ? `/${common.join("/")}` : "";
}

/**
 * One vocabulary for what happened to a file: Lix's own diff words, which
 * are the words Atelier's glyphs and review carry too. A card is a view of a
 * Lix diff; it should not rename what it is looking at.
 */
const TALLY_ORDER: ReadonlyArray<[DiffCardStatus, string]> = [
	["added", "added"],
	["modified", "modified"],
	["moved", "moved"],
	["removed", "removed"],
];

/** The one word for a set of changes that are all the same thing. */
const SINGLE_STATUS_WORD: Record<DiffCardStatus, string> = Object.fromEntries(
	TALLY_ORDER,
) as Record<DiffCardStatus, string>;

/** The status every change shares, or null when they differ. */
function sharedStatus(
	statuses: ReadonlyArray<DiffCardStatus>,
): DiffCardStatus | null {
	const first = statuses[0];
	if (first === undefined) return null;
	return statuses.every((status) => status === first) ? first : null;
}

/**
 * "2 added · 1 modified": only what happened, in a fixed order — and nothing at
 * all when every change is the same thing, because then the title has said
 * it and the bar would be saying it twice.
 */
export function tallyLabel(statuses: ReadonlyArray<DiffCardStatus>): string {
	if (sharedStatus(statuses)) return "";
	const parts: string[] = [];
	for (const [status, word] of TALLY_ORDER) {
		const count = statuses.filter((each) => each === status).length;
		if (count > 0) parts.push(`${count} ${word}`);
	}
	return parts.join(" · ");
}

/**
 * "1 file added", "3 files modified" — what happened, when one word covers
 * it. A set that did several things at once falls back to the tool's own
 * verb, "3 files written", and the bar's tally breaks it down.
 */
export function cardTitle(
	count: number,
	verb: "written" | "changed",
	statuses: ReadonlyArray<DiffCardStatus> = [],
): string {
	const shared = sharedStatus(statuses);
	const word = shared ? SINGLE_STATUS_WORD[shared] : verb;
	return `${count} ${count === 1 ? "file" : "files"} ${word}`;
}

/** What Atelier counts for a file: rows of a table, lines of a document. */
export function countUnit(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "csv" ? "rows" : "lines";
}

/**
 * The footer's words for one file: what happened, then how much, as far as
 * the render counted it.
 */
export function fileLabel(
	status: DiffCardStatus,
	counts: RenderCounts | undefined,
	unit: string,
	moved?: { readonly from: string; readonly to: string },
): string {
	const word = SINGLE_STATUS_WORD[status];
	if (status === "moved" && moved !== undefined) {
		const from = movedFromHint(moved.from, moved.to);
		return counts && counts.added + counts.removed + counts.modified > 0
			? `${word} from ${from} · ${changeTally(counts, unit)}`
			: `${word} from ${from}`;
	}
	if (!counts) return word;
	if (status === "added")
		return `${word} · ${counts.added} ${unitWord(counts.added, unit)}`;
	if (status === "removed" && counts.added === 0)
		return `${word} · ${counts.removed} ${unitWord(counts.removed, unit)}`;
	const tally = changeTally(counts, unit);
	return tally ? `${word} · ${tally}` : word;
}

function changeTally(counts: RenderCounts, unit: string): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`+${counts.added}`);
	if (counts.removed > 0) parts.push(`−${counts.removed}`);
	if (counts.modified > 0) parts.push(`~${counts.modified}`);
	return parts.length ? `${parts.join(" ")} ${unit}` : "";
}

function unitWord(count: number, unit: string): string {
	return count === 1 ? unit.replace(/s$/, "") : unit;
}

/** The old folder for a move across folders, the old name for a rename. */
function movedFromHint(movedFrom: string, path: string): string {
	const from = movedFrom.split("/").filter(Boolean);
	const to = path.split("/").filter(Boolean);
	const name = from.pop() ?? movedFrom;
	to.pop();
	if (from.join("/") === to.join("/")) return name;
	return from.length > 0 ? `${from.join("/")}/` : "/";
}

/** Atelier's icon for the file type, as markup the card can inline. */
export function fileIconSvg(path: string): string {
	const url = fileIconUrl(path);
	const comma = url.indexOf(",");
	const header = url.slice(0, comma);
	const data = url.slice(comma + 1);
	const svg = header.endsWith(";base64")
		? new TextDecoder().decode(base64ToBytes(data))
		: decodeURIComponent(data);
	return svg.trim();
}

/**
 * The card for a set of changes. Files past the preview budget are still
 * listed and paged, with a note in place of a view; files past the listing
 * budget are only counted. Returns null when nothing changed.
 */
export function diffCardPayload(input: {
	readonly verb: "written" | "changed";
	readonly changes: ReadonlyArray<DiffCardChange>;
	readonly repository?: string;
}): DiffCardPayload | null {
	if (input.changes.length === 0) return null;
	const listed = input.changes.slice(0, MAX_CARD_FILES);
	const files = listed.map((change, index) =>
		cardFile(change, index < MAX_PREVIEWS),
	);
	const folder = commonFolder(listed.map((file) => file.path));
	// Over every change, not only the listed ones: what the title says has to
	// hold for the files the card could not carry as well.
	const statuses = input.changes.map((change) => diffCardStatus(change));
	return {
		title: cardTitle(input.changes.length, input.verb, statuses),
		...(folder ? { folder } : {}),
		tally: tallyLabel(statuses),
		...(input.repository ? { repository: input.repository } : {}),
		files,
		more: input.changes.length - listed.length,
	};
}

function cardFile(change: DiffCardChange, withPreview: boolean): DiffCardFile {
	const status = diffCardStatus(change);
	const unit = countUnit(change.path);
	const moved =
		change.movedFrom !== undefined
			? { from: change.movedFrom, to: change.path }
			: undefined;
	const base = {
		path: change.path,
		name: change.path.split("/").filter(Boolean).at(-1) ?? change.path,
		status,
		url: change.url,
		icon: fileIconSvg(change.path),
	};
	if (!withPreview)
		return {
			...base,
			label: fileLabel(status, undefined, unit, moved),
			note: "Open it in LixRay to see this change",
		};
	const view = toHtml(
		{
			path: change.path,
			...(change.before !== undefined ? { before: change.before } : {}),
			...(change.after !== undefined ? { after: change.after } : {}),
		},
		{ maxBytes: MAX_PREVIEW_BYTES },
	);
	if (!isRendered(view)) {
		const note =
			view.skipped === "too-large"
				? "Too much changed to show here — open it in LixRay"
				: view.skipped === "unchanged"
					? status === "moved"
						? "Moved; the content is unchanged"
						: "The content is unchanged"
					: view.skipped === "unsupported"
						? "No preview for this file type — open it in LixRay"
						: view.skipped === "empty"
							? "The file is empty"
							: "Preview unavailable — open it in LixRay";
		return {
			...base,
			label: fileLabel(status, undefined, unit, moved),
			note,
		};
	}
	// The trimmed body names its own gaps — a document's pruned run, a
	// table's unchanged rows; saying it again reads as a second set of
	// missing lines.
	const note =
		view.hidden > 0 && !view.html.includes("-diff-gap")
			? `${view.hidden} more ${unitWord(view.hidden, unit)} in LixRay`
			: undefined;
	return {
		...base,
		label: fileLabel(status, view.counts, unit, moved),
		html: view.html,
		...(note ? { note } : {}),
		...(view.counts ? { counts: view.counts } : {}),
	};
}
