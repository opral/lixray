/** A static MCP Apps resource; per-call previews travel only in result metadata. */
export const WRITE_PREVIEW_URI = "ui://lixray/write-preview/v1";
export const MCP_APP_HTML = "text/html;profile=mcp-app";
export const WRITE_PREVIEW_META = "lixray/write-preview";
export type WritePreviewCard = { html: string };

// The small read-only view speaks the MCP Apps lifecycle directly. It never
// calls mutation tools. The HTML cards come from the server's static renderer;
// user-supplied Markdown is escaped/sanitized there, not evaluated in this view.
export const WRITE_PREVIEW_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LixRay file changes</title>
<style>
body { margin: 0; font: 14px system-ui, sans-serif; }
#status { margin: 12px; }
.preview { display: block; margin-bottom: 12px; }
</style></head><body>
<p id="status" role="status">Waiting for the write result…</p>
<main id="previews" aria-label="File changes"></main>
<script>
(() => {
  const status = document.getElementById('status');
  const previews = document.getElementById('previews');
  let ready = false;
  let nextId = 1;
  let canOpenLinks = false;
  let hostOrigin = '*';
  const pendingLinks = new Set();
  const send = message => parent.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin);
  const notify = (method, params) => send({ method, params });
  const size = new ResizeObserver(() => {
    if (ready) notify('ui/notifications/size-changed', { height: Math.ceil(document.body.getBoundingClientRect().height) });
  });
  size.observe(document.body);
  function render(result) {
    previews.replaceChildren();
    const summary = result.content?.find(block => block.type === 'text')?.text;
    status.textContent = summary || (result.isError ? 'The write failed.' : 'Files saved.');
    const cards = result.isError ? [] : result._meta?.['lixray/write-preview']?.cards;
    for (const card of (Array.isArray(cards) ? cards : []).slice(0, 3)) {
      if (typeof card.html !== 'string' || card.html.length > 24000) continue;
      const parsed = new DOMParser().parseFromString(card.html, 'text/html');
      const container = document.createElement('section');
      container.className = 'preview';
      // Isolate each complete card's styles without nested frames or network.
      const root = container.attachShadow({ mode: 'open' });
      const theme = document.createElement('style');
      theme.textContent = Array.from(parsed.querySelectorAll('head style'), node => node.textContent).join('\n').replaceAll(':root', ':host');
      root.append(theme, ...Array.from(parsed.body.childNodes));
      root.addEventListener('click', event => {
        const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
        if (!anchor) return;
        event.preventDefault();
        let url;
        try { url = new URL(anchor.href); } catch { return; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        if (!canOpenLinks) {
          status.textContent = 'Use the file link in the tool result to open LixRay.';
          return;
        }
        const id = nextId++;
        pendingLinks.add(id);
        send({ id, method: 'ui/open-link', params: { url: url.href } });
      });
      previews.append(container);
    }
  }
  function onMessage(event) {
    if (event.source !== parent || (hostOrigin !== '*' && event.origin !== hostOrigin)) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (!ready && message.id === 0 && !message.method) {
      if (message.error || message.result?.protocolVersion !== '2026-01-26') {
        status.textContent = 'Preview unavailable. Use the write receipt and file link in the tool result.';
        return;
      }
      // Sandboxed parents can have an opaque origin; source identity still binds the channel.
      if (event.origin !== 'null') hostOrigin = event.origin;
      ready = true;
      canOpenLinks = !!message.result.hostCapabilities?.openLinks;
      notify('ui/notifications/initialized', {});
      notify('ui/notifications/size-changed', { height: Math.ceil(document.body.getBoundingClientRect().height) });
      return;
    }
    if (!ready) return;
    if (pendingLinks.delete(message.id)) {
      if (message.error || message.result?.isError) status.textContent = 'Could not open the link. Use the file link in the tool result.';
      return;
    }
    if (message.method === 'ui/notifications/tool-result') render(message.params || {});
    else if (message.method === 'ui/notifications/tool-cancelled') {
      previews.replaceChildren();
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
    protocolVersion: '2026-01-26', appInfo: { name: 'LixRay file changes', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline'] }
  } });
})();
</script></body></html>`;
