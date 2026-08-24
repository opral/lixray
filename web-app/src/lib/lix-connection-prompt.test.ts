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
		/^Lixray is a host for Lix repositories\. Documentation is under https:\/\/lixray\.com\/docs\.\n\nThis team's company repository is Lixray @samuel\/repository \(8b4382f8-239d-4b76-bb77-401de5f1d6ae\)\./,
	);
	assert.match(details.prompt, /http:\/\/127\.0\.0\.1:8787\/mcp/);
	assert.match(details.serverName, /^[a-zA-Z0-9_-]+$/);
	assert.doesNotMatch(details.prompt, /Preview:/);
	assert.doesNotMatch(details.prompt, /Setup docs:/);
	assert.match(
		details.prompt,
		/Agents cannot add connectors from the chat, so guide the user to add it manually/,
	);
	assert.match(
		details.prompt,
		/If LixRay_Dev is already connected, reuse it\./,
	);
	assert.doesNotMatch(details.prompt, /plugins/);
});

void test("uses Lixray in production and starts with one user-picked skill", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(details.serverName, "LixRay");
	assert.equal(details.documentationUrl, "https://app.lixray.com/docs/mcp");
	assert.match(details.prompt, /^Lixray is a host for Lix repositories\./);
	assert.match(
		details.prompt,
		/Documentation is under https:\/\/lixray\.com\/docs\./,
	);
	assert.doesNotMatch(details.prompt, /local connection/);
	assert.match(
		details.prompt,
		/Lixray is added as a normal MCP connector\./,
	);
	assert.match(
		details.prompt,
		/guide the user to add it manually/,
	);
	assert.match(
		details.prompt,
		/put this in the team's shared AGENTS\.md or CLAUDE\.md/,
	);
	assert.match(
		details.prompt,
		/Do not save it to personal agent memory/,
	);
	assert.doesNotMatch(details.prompt, /Save this as durable agent memory/);
	assert.match(
		details.prompt,
		/Once that file is updated, ask the user which single skill to put in Lixray\./,
	);
	assert.match(details.prompt, /They pick or create it\./);
	assert.match(details.prompt, /Write only that one skill file\./);
});

void test("does not survey private memory or request a bulk upload", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.doesNotMatch(details.prompt, /Save this as durable agent memory/);
	assert.doesNotMatch(details.prompt, /check the memory/i);
	assert.doesNotMatch(details.prompt, /survey/i);
	assert.doesNotMatch(details.prompt, /upload/i);
	assert.doesNotMatch(details.prompt, /private files/i);
	assert.doesNotMatch(details.prompt, /workflows\/files/);
	assert.doesNotMatch(details.prompt, /setting up their repository/);
	assert.doesNotMatch(details.prompt, /the lix has no files/);
	assert.doesNotMatch(details.prompt, /Lix's goal/);
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
		words.length <= 165,
		`expected at most 165 words, got ${words.length}`,
	);
	assert.doesNotMatch(details.prompt, /active_branch_id/);
	assert.doesNotMatch(details.prompt, /first files/);
});
