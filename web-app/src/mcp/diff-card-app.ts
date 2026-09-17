import { DIFF_CARD_STYLE } from "./diff-card.ts";

/**
 * A static MCP Apps resource; per-call cards travel only in result metadata.
 *
 * The card is one 44px bar until the reader opens it: the file icons, how
 * many files and where, what happened to them, a chevron. Open, the bar is
 * the header and below it sits Atelier's view of one file at a time, with a
 * dark pill to page through the rest and the way back to the app. A long
 * chat therefore reads as a list of writes, and each one is a glance away
 * from the change itself.
 *
 * Both heights are fixed — a one-line note and a long document open the same
 * amount. The head follows the chat's colour scheme, so a closed card reads
 * as one more line of it; the file below the head is Atelier's view in
 * Atelier's own light scheme, with a toggle in the foot for a reader who
 * wants it dark.
 */
export const DIFF_CARD_URI = "ui://lixray/diff-card/v1";
export const MCP_APP_HTML = "text/html;profile=mcp-app";
export const DIFF_CARD_META = "lixray/diff-card";

/** The bar's height in both states; the host sizes the frame to it. */
export const DIFF_CARD_BAR_HEIGHT = 44;

/**
 * The card's height open, whatever file it carries.
 *
 * A short note and a long document would otherwise open to different heights,
 * and a chat of cards would jump by a different amount each time one is
 * opened. The frame is this tall for every card; the file scrolls inside it.
 */
export const DIFF_CARD_OPEN_HEIGHT = 480;

/**
 * Atelier's diff glyph (design 23d), mirrored from
 * vendor/atelier/src/components/diff-glyph-geometry.ts so every surface draws
 * the same shape; a test keeps the two in step. The fill is the status
 * colour and the knockout is the ground the dot sits on.
 */
export const DIFF_GLYPH = {
	viewBox: "0 0 12 12",
	radius: 5,
	stroke: 1.7,
	knockout: {
		added: "M6 3.6v4.8M3.6 6h4.8",
		modified: "M3.3 6.3c.9-1.5 1.8-1.5 2.7 0s1.8 1.5 2.7 0",
		removed: "M3.6 6h4.8",
		moved: "M4.8 3.6 7.2 6 4.8 8.4",
	},
} as const;

// The small read-only view speaks the MCP Apps lifecycle directly. It never
// calls mutation tools. The previews come from the server's static renderer;
// user-supplied Markdown is escaped/sanitized there, not evaluated in this view.
export const DIFF_CARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LixRay file changes</title>
<style id="atelier">${DIFF_CARD_STYLE}</style>
<style>
/* The card's head is chrome: it belongs to the chat and follows the scheme
   that chat is in, so a closed card reads as one more line of it. The host
   has the last word — it sets the scheme on this document directly. What is
   below the head is Atelier, in Atelier's own light palette (see .details),
   until the reader asks for the other one. */
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font: 13px/1.4 system-ui, sans-serif; color: var(--atelier-fg); }
#status { margin: 0; padding: 12px; color: var(--atelier-fg-muted); }
#status[hidden], .card[hidden], .details[hidden], [hidden] { display: none; }
.card {
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	border: 1px solid var(--atelier-border);
	border-radius: 10px;
	background: var(--atelier-panel);
	overflow: hidden;
}
/* One height open, for every card: see DIFF_CARD_OPEN_HEIGHT. The state is
   not called "open": that class is the button that opens LixRay. */
.card.expanded { height: ${DIFF_CARD_OPEN_HEIGHT}px; }
/* The bar is 44px with its borders, open or closed: a chat of these is a list. */
.bar {
	display: flex;
	align-items: center;
	gap: 10px;
	box-sizing: border-box;
	width: 100%;
	height: ${DIFF_CARD_BAR_HEIGHT - 2}px;
	margin: 0;
	padding: 0 12px 0 12px;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.bar:hover { background: var(--atelier-bg-hover); }
.bar:focus-visible { outline: 2px solid var(--atelier-ring); outline-offset: -2px; }
.icons { display: flex; flex: none; align-items: center; }
.icons .icon {
	display: block;
	width: 16px;
	height: 16px;
	/* A one-pixel ring in the panel colour, so the stack reads as a stack. */
	filter: drop-shadow(1px 0 0 var(--atelier-panel)) drop-shadow(-1px 0 0 var(--atelier-panel)) drop-shadow(0 1px 0 var(--atelier-panel)) drop-shadow(0 -1px 0 var(--atelier-panel));
}
.icons .icon + .icon, .icons .icon + .over { margin-left: -5px; }
.icons .icon svg { display: block; width: 16px; height: 16px; }
.icons .over {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 16px;
	min-width: 16px;
	padding: 0 3px;
	border-radius: 8px;
	box-shadow: 0 0 0 1px var(--atelier-panel);
	background: var(--atelier-bg-subtle);
	color: var(--atelier-fg-muted);
	font-size: 10px;
	font-weight: 600;
}
.title { flex: none; font-weight: 600; white-space: nowrap; }
.folder {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--atelier-fg-muted);
	white-space: nowrap;
}
.tally {
	flex: none;
	margin-left: auto;
	color: var(--atelier-fg-subtle);
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.chevron { flex: none; width: 14px; height: 14px; color: var(--atelier-fg-subtle); transition: transform 120ms; }
.bar[aria-expanded="true"] .chevron { transform: rotate(180deg); }
/* The file, and the words around it: Atelier's view, in Atelier's scheme
   rather than the chat's. The toggle in the foot sets this one property. */
.details {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	min-height: 0;
	border-top: 1px solid var(--atelier-border-subtle);
	padding: 10px 12px 12px;
	background: var(--atelier-panel);
	color: var(--atelier-fg);
	color-scheme: light;
}
/* The frame is one height, so the panel is what is left of it, and a file
   longer than that scrolls here: the transcript stays still, the file moves. */
.panel {
	box-sizing: border-box;
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	overscroll-behavior: contain;
	border: 1px solid var(--atelier-border-subtle);
	border-radius: 8px;
	background: var(--atelier-panel);
}
.foot { display: flex; flex: none; align-items: center; gap: 10px; margin-top: 10px; }
.pill {
	display: inline-flex;
	flex: 0 1 auto;
	min-width: 0;
	align-items: center;
	gap: 8px;
	height: 30px;
	padding: 0 8px 0 4px;
	border-radius: 15px;
	background: var(--atelier-overlay);
	color: var(--atelier-overlay-fg);
}
.pill .arrow {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 22px;
	height: 22px;
	padding: 0;
	border: 0;
	border-radius: 11px;
	background: transparent;
	color: var(--atelier-overlay-fg-muted);
	cursor: pointer;
}
.pill .arrow:hover:not(:disabled) { background: var(--atelier-overlay-hover); color: var(--atelier-overlay-fg); }
.pill .arrow:disabled { color: var(--atelier-overlay-fg-subtle); cursor: default; }
.pill .arrow:focus-visible { outline: 2px solid var(--atelier-overlay-accent); outline-offset: -2px; }
.pill .arrow svg { width: 12px; height: 12px; }
.pill .badge { display: inline-flex; flex: none; }
.pill .badge svg { width: 12px; height: 12px; }
/* The file's own icon beside its badge: the badge says what happened, the
   icon says to what — the same pair the bar leads with. */
.pill .file-icon { display: inline-flex; flex: none; }
.pill .file-icon svg { display: block; width: 14px; height: 14px; }
.pill .file-icon:empty { display: none; }
.pill .name { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 12px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.pill .label { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--atelier-overlay-fg-subtle); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; text-overflow: ellipsis; }
/* "new · 10 lines": what happened carries the glyph's colour, the count
   stays quiet. The pill is dark chrome in either scheme, so these are the
   overlay's own diff tones rather than the page's. */
.pill .label .word { font-weight: 600; }
.pill .label[data-status="added"] .word { color: var(--atelier-overlay-diff-added); }
.pill .label[data-status="modified"] .word { color: var(--atelier-overlay-diff-modified); }
.pill .label[data-status="removed"] .word { color: var(--atelier-overlay-diff-removed); }
.pill .label[data-status="moved"] .word { color: var(--atelier-overlay-diff-moved); }
.pill .dots { display: inline-flex; flex: none; align-items: center; gap: 4px; margin-left: 2px; }
.pill .dots i { display: block; width: 5px; height: 5px; border-radius: 3px; background: var(--atelier-overlay-fg-subtle); }
.pill .dots i.on { background: var(--atelier-overlay-fg); }
.pill.single .arrow, .pill.single .dots { display: none; }
.repo { flex: 0 1 auto; min-width: 0; overflow: hidden; margin-left: auto; color: var(--atelier-fg-subtle); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
/* The scheme the card is read in: the chat's, until the reader says
   otherwise. A quiet icon beside the way back to the app. */
.scheme {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: 0;
	border-radius: 13px;
	background: transparent;
	color: var(--atelier-fg-subtle);
	cursor: pointer;
}
.scheme:hover { background: var(--atelier-bg-hover); color: var(--atelier-fg-muted); }
.scheme:focus-visible { outline: 2px solid var(--atelier-ring); outline-offset: -2px; }
.scheme svg { display: block; width: 14px; height: 14px; }
.open {
	flex: none;
	padding: 6px 11px;
	border: 0;
	border-radius: 7px;
	background: var(--atelier-accent);
	color: var(--atelier-accent-on);
	font: inherit;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
}
.open:hover { background: var(--atelier-accent-hover); }
.open:focus-visible { outline: 2px solid var(--atelier-ring); outline-offset: 2px; }
</style></head><body>
<p id="status" role="status">Waiting for the result…</p>
<section class="card" id="card" hidden>
	<button class="bar" id="bar" type="button" aria-expanded="false" aria-controls="details">
		<span class="icons" id="icons"></span>
		<span class="title" id="title"></span>
		<span class="folder" id="folder"></span>
		<span class="tally" id="tally"></span>
		<svg class="chevron" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5.25 7 9.25l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
	</button>
	<div class="details" id="details" hidden>
		<div class="panel" id="panel"></div>
		<div class="foot">
			<div class="pill" id="pill">
				<button class="arrow" id="prev" type="button" aria-label="Previous file"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
				<span class="badge" id="badge"></span>
				<span class="file-icon" id="file-icon"></span>
				<span class="name" id="name"></span>
				<span class="label" id="label"></span>
				<span class="dots" id="dots"></span>
				<button class="arrow" id="next" type="button" aria-label="Next file"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
			</div>
			<span class="repo" id="repo"></span>
			<button class="scheme" id="scheme" type="button"></button>
			<button class="open" id="open" type="button">Open in LixRay</button>
		</div>
	</div>
</section>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const status = $('status'), card = $('card'), bar = $('bar');
  const details = $('details'), panel = $('panel'), pill = $('pill');
  let ready = false;
  let nextId = 1;
  let canOpenLinks = false;
  let hostOrigin = '*';
  const pendingLinks = new Set();
  let payload = null;
  let index = 0;
  let expanded = false;
  const send = message => parent.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin);
  const notify = (method, params) => send({ method, params });
  // Two heights, and the file inside the card absorbs the difference: a
  // chat of cards is a list that does not reflow as one of them is opened.
  const BAR = ${DIFF_CARD_BAR_HEIGHT}, OPEN = ${DIFF_CARD_OPEN_HEIGHT};
  const height = () => card.hidden
    ? Math.ceil(document.body.getBoundingClientRect().height)
    : (expanded ? OPEN : BAR);
  // A host that honours the notification resizes on it; one that measures the
  // frame instead reads this document's own height, and finds the card and
  // nothing else — no strip of the host's background below it.
  const reportSize = () => {
    const next = height();
    document.documentElement.style.height = next + 'px';
    if (ready) notify('ui/notifications/size-changed', { height: next });
  };
  const size = new ResizeObserver(() => { fitFolder(); reportSize(); });
  size.observe(document.body);
  reportSize();

  // The glyph is Atelier's: a status-coloured dot with a knockout in the
  // colour of the ground it sits on (the pill).
  const GLYPH = ${JSON.stringify(DIFF_GLYPH)};
  const FILL = {
    added: 'var(--atelier-overlay-diff-added)', modified: 'var(--atelier-overlay-diff-modified)',
    removed: 'var(--atelier-overlay-diff-removed)', moved: 'var(--atelier-overlay-diff-moved)'
  };
  const WORD = { added: 'Added', modified: 'Modified', removed: 'Removed', moved: 'Moved' };
  const svgNs = 'http://www.w3.org/2000/svg';
  function glyph(status) {
    const kind = FILL[status] ? status : 'modified';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', GLYPH.viewBox);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', WORD[kind]);
    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', '6'); dot.setAttribute('cy', '6'); dot.setAttribute('r', String(GLYPH.radius));
    dot.setAttribute('fill', FILL[kind]);
    const cut = document.createElementNS(svgNs, 'path');
    cut.setAttribute('d', GLYPH.knockout[kind]);
    cut.setAttribute('stroke', 'var(--atelier-overlay)');
    cut.setAttribute('stroke-width', String(GLYPH.stroke));
    cut.setAttribute('fill', 'none');
    cut.setAttribute('stroke-linecap', 'round');
    cut.setAttribute('stroke-linejoin', 'round');
    svg.append(dot, cut);
    return svg;
  }
  // Icons and previews are the server's own markup; they are adopted as
  // parsed nodes, never evaluated, and a preview cannot carry a script.
  function iconNode(markup) {
    if (typeof markup !== 'string' || markup.length > 4000) return null;
    const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    if (!root || root.localName !== 'svg' || root.querySelector('script, foreignObject')) return null;
    root.removeAttribute('width'); root.removeAttribute('height');
    root.setAttribute('aria-hidden', 'true');
    return document.importNode(root, true);
  }
  // Every preview shares one shadow root and Atelier's one stylesheet.
  const shadow = panel.attachShadow({ mode: 'open' });
  const theme = document.createElement('style');
  theme.textContent = $('atelier').textContent.replaceAll(':root', ':host');
  const chrome = document.createElement('style');
  chrome.textContent = ':host{color-scheme:inherit}.preview{display:block;padding:12px 14px 14px}.note{padding:12px 14px;color:var(--atelier-fg-muted)}.note.only{display:flex;box-sizing:border-box;min-height:100%;align-items:center;justify-content:center;padding:28px 14px;text-align:center}[hidden]{display:none}';
  const preview = document.createElement('div');
  preview.className = 'preview atelier-render';
  const note = document.createElement('div');
  note.className = 'note';
  shadow.append(theme, chrome, preview, note);

  function render(result) {
    const summary = result.content?.find(block => block.type === 'text')?.text;
    status.textContent = summary || (result.isError ? 'The call failed.' : 'Done.');
    const meta = result.isError ? null : result._meta?.[${JSON.stringify(DIFF_CARD_META)}];
    const files = meta && Array.isArray(meta.files) ? meta.files.filter(file => file && typeof file.path === 'string') : [];
    if (files.length === 0) {
      payload = null;
      card.hidden = true;
      status.hidden = false;
      return;
    }
    payload = { ...meta, files };
    index = 0;
    // The host already prints the receipt beside this view; the card says the rest.
    status.hidden = true;
    card.hidden = false;
    const icons = $('icons');
    icons.replaceChildren();
    const shown = files.slice(0, 3);
    for (const file of shown) {
      const icon = iconNode(file.icon);
      if (!icon) continue;
      const span = document.createElement('span');
      span.className = 'icon';
      span.append(icon);
      icons.append(span);
    }
    if (files.length > 3) {
      const over = document.createElement('span');
      over.className = 'over';
      over.textContent = '+' + (files.length - 3 + (meta.more || 0));
      icons.append(over);
    }
    $('title').textContent = typeof meta.title === 'string' ? meta.title : files.length + ' files';
    $('folder').dataset.path = typeof meta.folder === 'string' ? meta.folder : '';
    fitFolder();
    $('tally').textContent = typeof meta.tally === 'string' ? meta.tally : '';
    $('repo').textContent = typeof meta.repository === 'string' ? meta.repository : '';
    setExpanded(false);
    page(0);
  }
  // The folder keeps its tail: "…/parent/folder" is where the reader is.
  function fitFolder() {
    const folder = $('folder');
    const path = folder.dataset.path || '';
    if (!path) { folder.textContent = ''; return; }
    const segments = path.split('/').filter(Boolean);
    for (let drop = 0; drop < segments.length; drop += 1) {
      folder.textContent = 'in ' + (drop > 0 ? '…/' : '') + segments.slice(drop).join('/');
      if (folder.scrollWidth <= folder.clientWidth) return;
    }
    folder.textContent = 'in …/' + segments[segments.length - 1];
  }
  function setExpanded(next) {
    expanded = next;
    bar.setAttribute('aria-expanded', String(next));
    card.classList.toggle('expanded', next);
    details.hidden = !next;
    reportSize();
  }
  function page(next) {
    if (!payload) return;
    const files = payload.files;
    index = Math.max(0, Math.min(files.length - 1, next));
    const file = files[index];
    preview.replaceChildren();
    if (typeof file.html === 'string' && file.html.length <= 30000) {
      const parsed = new DOMParser().parseFromString(file.html, 'text/html');
      for (const bad of parsed.querySelectorAll('script, iframe, object, embed, link, meta, base')) bad.remove();
      preview.append(...Array.from(parsed.body.childNodes));
    }
    preview.hidden = preview.childNodes.length === 0;
    note.textContent = typeof file.note === 'string' ? file.note : '';
    note.hidden = !note.textContent;
    note.className = preview.hidden ? 'note only' : 'note';
    panel.scrollTop = 0;
    $('badge').replaceChildren(glyph(file.status));
    const fileIcon = iconNode(file.icon);
    $('file-icon').replaceChildren(...(fileIcon ? [fileIcon] : []));
    $('name').textContent = typeof file.name === 'string' ? file.name : file.path;
    const label = $('label');
    const words = typeof file.label === 'string' ? file.label : '';
    const cut = words.indexOf(' · ');
    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = cut === -1 ? words : words.slice(0, cut);
    label.dataset.status = FILL[file.status] ? file.status : 'modified';
    label.replaceChildren(word, cut === -1 ? '' : words.slice(cut));
    const dots = $('dots');
    dots.replaceChildren(...files.map((_, i) => {
      const dot = document.createElement('i');
      if (i === index) dot.className = 'on';
      return dot;
    }));
    pill.classList.toggle('single', files.length === 1);
    $('prev').disabled = index === 0;
    $('next').disabled = index === files.length - 1;
    reportSize();
  }
  // The scheme the file is read in. The head follows the chat; below it the
  // card is Atelier, and Atelier is a light application — until the reader
  // says otherwise for this card, on one element, which the preview's shadow
  // root inherits along with everything else in the body.
  const SUN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="2.9" fill="currentColor"/><g stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M7 .8v1.5M7 11.7v1.5M13.2 7h-1.5M2.3 7H.8M11.4 2.6l-1.1 1.1M3.7 10.3l-1.1 1.1M11.4 11.4l-1.1-1.1M3.7 3.7 2.6 2.6"/></g></svg>';
  const MOON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M12.2 8.7A5.5 5.5 0 0 1 5.3 1.8a5.7 5.7 0 1 0 6.9 6.9Z" fill="currentColor"/></svg>';
  const scheme = $('scheme');
  let bodyDark = false;
  function paintScheme() {
    scheme.replaceChildren(iconNode(bodyDark ? SUN : MOON));
    const label = bodyDark
      ? 'Read this file in the light scheme'
      : 'Read this file in the dark scheme';
    scheme.setAttribute('aria-label', label);
    scheme.title = label;
  }
  scheme.addEventListener('click', () => {
    bodyDark = !bodyDark;
    details.style.setProperty('color-scheme', bodyDark ? 'dark' : 'light');
    paintScheme();
  });
  paintScheme();
  bar.addEventListener('click', () => setExpanded(!expanded));
  $('prev').addEventListener('click', () => page(index - 1));
  $('next').addEventListener('click', () => page(index + 1));
  $('open').addEventListener('click', () => {
    const file = payload && payload.files[index];
    if (!file) return;
    let url;
    try { url = new URL(file.url); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    if (!canOpenLinks) {
      status.hidden = false;
      status.textContent = 'Use the file link in the tool result to open LixRay.';
      return;
    }
    const id = nextId++;
    pendingLinks.add(id);
    send({ id, method: 'ui/open-link', params: { url: url.href } });
  });
  function onMessage(event) {
    if (event.source !== parent || (hostOrigin !== '*' && event.origin !== hostOrigin)) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (!ready && message.id === 0 && !message.method) {
      if (message.error || message.result?.protocolVersion !== '2026-01-26') {
        status.textContent = 'Preview unavailable. Use the receipt and file links in the tool result.';
        return;
      }
      // Sandboxed parents can have an opaque origin; source identity still binds the channel.
      if (event.origin !== 'null') hostOrigin = event.origin;
      ready = true;
      canOpenLinks = !!message.result.hostCapabilities?.openLinks;
      notify('ui/notifications/initialized', {});
      reportSize();
      return;
    }
    if (!ready) return;
    if (pendingLinks.delete(message.id)) {
      if (message.error || message.result?.isError) {
        status.hidden = false;
        status.textContent = 'Could not open the link. Use the file link in the tool result.';
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-result') render(message.params || {});
    else if (message.method === 'ui/notifications/tool-cancelled') {
      payload = null;
      card.hidden = true;
      status.hidden = false;
      status.textContent = 'The tool call was cancelled. Check its outcome before repeating a write.';
    } else if (message.method === 'ping' && message.id !== undefined) send({ id: message.id, result: {} });
    else if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
      size.disconnect();
      window.removeEventListener('message', onMessage);
      send({ id: message.id, result: {} });
    } else if (message.id !== undefined && message.method) send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
  window.addEventListener('message', onMessage);
  send({ id: 0, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: 'LixRay file changes', version: '2.0.0' },
    appCapabilities: { availableDisplayModes: ['inline'] }
  } });
})();
</script></body></html>`;
