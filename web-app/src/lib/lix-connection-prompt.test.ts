import assert from "node:assert/strict";
import test from "node:test";
import { createLixConnectionDetails } from "./lix-connection-prompt.ts";

const lix = {
	lixId: "8b4382f8-239d-4b76-bb77-401de5f1d6ae",
	namespace: "samuel",
	lixSlug: "repository",
	lixName: "Repository",
};

void test("uses a Codex-safe isolated development registration on localhost", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "http://127.0.0.1:8787",
	});

	assert.equal(details.serverName, "LixRay_Dev");
	assert.equal(details.mcpUrl, "http://127.0.0.1:8787/mcp");
	assert.match(details.serverName, /^[a-zA-Z0-9_-]+$/);
	assert.match(
		details.prompt,
		/Guide the user to add LixRay_Dev from the marketplace, or add the MCP manually at http:\/\/127\.0\.0\.1:8787\/mcp and authenticate\./,
	);
	assert.match(
		details.prompt,
		/If LixRay_Dev is already connected, reuse it\./,
	);
});

void test("says what it is for, which repository, and how to add it", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(details.serverName, "LixRay");
	assert.equal(details.documentationUrl, "https://app.lixray.com/docs/mcp");
	assert.equal(
		details.prompt,
		`Connect the user to Lixray's MCP.

Docs can be found under https://lixray.com/docs. This Lixray repository is @samuel/repository (8b4382f8-239d-4b76-bb77-401de5f1d6ae). Lixray is added as a normal MCP connector. Guide the user to add LixRay from the marketplace, or add the MCP manually at https://app.lixray.com/mcp and authenticate. If LixRay is already connected, reuse it.

Guide the user on usage of lixray.`,
	);
});

void test("uses the production prompt template for local development", () => {
	const local = createLixConnectionDetails({
		...lix,
		origin: "http://127.0.0.1:8787",
	});
	const production = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(
		local.prompt
			.replaceAll("LixRay_Dev", "LixRay")
			.replaceAll("http://127.0.0.1:8787", "https://app.lixray.com"),
		production.prompt,
	);
});

void test("asks for nothing beyond the connection", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});
	const words = details.prompt.trim().split(/\s+/);

	assert.ok(
		words.length <= 80,
		`expected at most 80 words, got ${words.length}`,
	);
	// The prompt connects the agent. What it then reads, writes or remembers
	// is the server's business, and the server's instructions say it — a
	// pasted prompt is the wrong place to carry data-handling rules that must
	// hold whether or not anyone pasted it.
	assert.doesNotMatch(details.prompt, /AGENTS\.md|CLAUDE\.md/);
	assert.doesNotMatch(details.prompt, /skill/i);
	assert.doesNotMatch(details.prompt, /memory|chat history/i);
	assert.doesNotMatch(details.prompt, /upload|survey|private files/i);
	assert.doesNotMatch(details.prompt, /personal stuff or company stuff/);
	assert.doesNotMatch(details.prompt, /Preview:|Setup docs:/);
	assert.doesNotMatch(details.prompt, /cannot add|cannot connect/i);
});
