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
	assert.match(
		details.prompt,
		/^Guide the user to connect to this MCP server for Lix repository @samuel\/repository \(8b4382f8-239d-4b76-bb77-401de5f1d6ae\): \[http:\/\/127\.0\.0\.1:8787\/mcp\]\(http:\/\/127\.0\.0\.1:8787\/mcp\)\./,
	);
	assert.match(details.serverName, /^[a-zA-Z0-9_-]+$/);
	assert.doesNotMatch(details.prompt, /Preview:/);
	assert.doesNotMatch(details.prompt, /Setup docs:/);
	assert.match(
		details.prompt,
		/The user must connect and authenticate it themselves because agents cannot connect MCP servers from the chat\./,
	);
	assert.match(
		details.prompt,
		/If LixRay_Dev is already connected, reuse it\./,
	);
	assert.doesNotMatch(details.prompt, /plugins/);
	assert.match(details.prompt, /Once connected, and the lix has no files/);
	assert.match(details.prompt, /Lix's goal is a repository for non-code\./);
	assert.match(details.prompt, /icp\.md, skills/);
});

void test("uses LixRay in production and asks for the first files", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(details.serverName, "LixRay");
	assert.equal(details.documentationUrl, "https://app.lixray.com/docs/mcp");
	assert.doesNotMatch(details.prompt, /local connection/);
	assert.match(details.prompt, /guide the user in setting up their repository/);
	assert.match(details.prompt, /a repository for your entire company/);
	assert.match(
		details.prompt,
		/Generally check the memory to what the user's workflows\/files are that benefit most from being in a repository\./,
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

void test("keeps the connection prompt concise", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "http://127.0.0.1:8787",
	});
	const words = details.prompt.trim().split(/\s+/);

	assert.ok(
		words.length <= 110,
		`expected at most 110 words, got ${words.length}`,
	);
	assert.doesNotMatch(details.prompt, /active_branch_id/);
	assert.doesNotMatch(details.prompt, /first files/);
});
