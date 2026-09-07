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
			import { RepositoryAccessScreen } from "./src/components/repository-access-screen.tsx";
			export const renderScreen = (props) => renderToStaticMarkup(createElement(RepositoryAccessScreen, props));
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
const { render, renderScreen } = compiled.exports;

test("initial HTML explains how to access a document through MCP", () => {
	const html = render("/@opral/monorepo/file/company-brain-productization.md");
	assert.match(html, /To check access and read this file/);
	assert.match(html, /permissions/);
	assert.match(html, /class="sr-only /);
	assert.doesNotMatch(
		html,
		/<details|hidden=|aria-hidden=|is available through/,
	);
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
	assert.match(
		render("/@opral/monorepo"),
		/To check access and read this repository/,
	);
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

test("the initial screen shows a neutral access check and native MCP disclosure", () => {
	const html = renderScreen({
		pathname: "/@opral/repo/file/notes.md",
		searchStr: "?invite=secret",
	});
	assert.match(html, /Opening file/);
	assert.match(html, /data-repository-access="pending"/);
	assert.match(html, /disabled=""/);
	assert.match(html, /<details[^>]*><summary/);
	assert.match(html, /open_lix/);
	assert.doesNotMatch(
		html,
		/404|isn&#x27;t available|secret|<details[^>]*open=/,
	);
});

test("unavailable resources offer account recovery without claiming existence", () => {
	for (const signedIn of [true, false]) {
		const html = renderScreen({
			pathname: "/@opral/repo/file/notes.md",
			searchStr: "",
			status: "unavailable",
			signedIn,
		});
		assert.match(html, /404/);
		assert.match(html, /This file isn&#x27;t available/);
		assert.match(html, signedIn ? /Switch account/ : /Sign in/);
		assert.match(html, /href="\/home"/);
		assert.doesNotMatch(html, /disabled=/);
	}
});

test("connection failures remain retryable errors, not false 404s", () => {
	const html = renderScreen({
		pathname: "/@opral/repo",
		searchStr: "",
		status: "error",
	});
	assert.match(html, /Unable to check repository access/);
	assert.match(html, /Retry/);
	assert.doesNotMatch(html, /404/);
});

test("escapes URL-controlled markup in server HTML", () => {
	const html = render(
		"/@opral/repo/file/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
		"?branch=%3Cimg%3E",
	);
	assert.doesNotMatch(html, /<script>|<img>/);
	assert.match(html, /&lt;script&gt;/);
});
