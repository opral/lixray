import assert from "node:assert/strict";
import test from "node:test";
import { createLixConnectionDetails } from "./lix-connection-prompt.ts";

const lix = {
	lixId: "8b4382f8-239d-4b76-bb77-401de5f1d6ae",
	namespace: "samuel",
	lixSlug: "workspace",
	lixName: "Workspace",
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
		/^Connect this agent to my Lix repository `@samuel\/workspace`\./,
	);
	assert.match(
		details.prompt,
		/Otherwise, create and authenticate it with http:\/\/127\.0\.0\.1:8787\/mcp/,
	);
	assert.match(details.serverName, /^[a-zA-Z0-9_-]+$/);
	assert.doesNotMatch(details.prompt, /Preview:/);
	assert.doesNotMatch(details.prompt, /Setup docs:/);
	assert.match(details.prompt, /Never open either URL in a browser/);
	assert.match(details.prompt, /Call active_branch_id with this exact Lix ID/);
	assert.match(details.prompt, /If that connection already exists, reuse it/);
	assert.match(details.prompt, /Otherwise, create and authenticate it/);
	assert.match(
		details.prompt,
		/If you cannot connect, stop and tell me exactly what I need to do next/,
	);
	assert.doesNotMatch(details.prompt, /fresh task/);
	assert.doesNotMatch(details.prompt, /shell|subprocess|Node workaround/);
});

void test("uses LixRay in production and asks for the first files", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(details.serverName, "LixRay");
	assert.equal(details.documentationUrl, "https://app.lixray.com/docs/mcp");
	assert.doesNotMatch(details.prompt, /local connection/);
	assert.match(details.prompt, /ask me for the first files/);
	assert.match(details.prompt, /Do not inspect unrelated apps or files/);
	assert.match(details.prompt, /or write yet/);
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
			.replaceAll("`LixRay_Dev`", "`LixRay`")
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
	assert.doesNotMatch(details.prompt, /recent working context/);
	assert.doesNotMatch(details.prompt, /ingestion plan/);
});
