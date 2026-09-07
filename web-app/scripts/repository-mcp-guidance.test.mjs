import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Render the actual component without a browser or JavaScript hydration.
const bundle = await build({
	stdin: {
		contents: `
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server.node";
			import { RepositoryMcpGuidance } from "./src/components/repository-mcp-guidance.tsx";
			export const render = (pathname, searchStr = "") =>
				renderToStaticMarkup(createElement(RepositoryMcpGuidance, { pathname, searchStr }));
		`,
		resolveDir: fileURLToPath(new URL("..", import.meta.url)),
	},
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	define: { "process.env.NODE_ENV": '"production"' },
});
const compiled = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
	createRequire(import.meta.url),
	compiled,
	compiled.exports,
);
const { render } = compiled.exports;

test("initial HTML explains how to access a document through MCP", () => {
	const html = render("/@opral/monorepo/file/company-brain-productization.md");
	assert.match(html, /This document is available through LixRay MCP/);
	assert.match(html, /Repository: <code>@opral\/monorepo<\/code>/);
	assert.match(html, /File: <code>company-brain-productization.md<\/code>/);
	assert.match(html, /open_lix/);
	assert.match(html, /lix_ref&quot;:&quot;@opral\/monorepo/);
	assert.match(html, /href="\/mcp\/docs"/);
	assert.match(html, /href="https:\/\/lixray.com\/mcp"/);
	assert.match(html, /ask the user to connect LixRay/);
});

test("preserves encoded file paths and branches without leaking invite tokens", () => {
	const html = render(
		"/%40opral/monorepo/file/notes/a%20b.md",
		"?branch=feature-1&invite=secret",
	);
	assert.match(html, /notes\/a b.md/);
	assert.match(html, /branch_id&quot;:&quot;feature-1/);
	assert.doesNotMatch(html, /secret|invite/);
});

test("renders repository guidance but leaves unrelated and malformed routes alone", () => {
	assert.match(render("/@opral/monorepo"), /This repository is available/);
	assert.doesNotMatch(render("/@opral/monorepo/dir/notes"), /File:/);
	for (const path of [
		"/",
		"/docs/mcp",
		"/settings/@opral",
		"/@opral",
		"/@opral/repo/file/%ZZ",
	]) {
		assert.equal(render(path), "");
	}
});

test("escapes URL-controlled markup in server HTML", () => {
	const html = render(
		"/@opral/repo/file/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
		"?branch=%3Cimg%3E",
	);
	assert.doesNotMatch(html, /<script>|<img>/);
	assert.match(html, /&lt;script&gt;/);
});
