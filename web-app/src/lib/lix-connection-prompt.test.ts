import assert from "node:assert/strict";
import test from "node:test";
import { createLixConnectionDetails } from "./lix-connection-prompt.ts";

const lix = {
	lixId: "8b4382f8-239d-4b76-bb77-401de5f1d6ae",
	namespace: "samuel",
	lixSlug: "workspace",
	lixName: "Workspace",
};

void test("uses an isolated LixRay Dev MCP registration on localhost", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "http://127.0.0.1:8787",
	});

	assert.equal(details.serverName, "LixRay Dev");
	assert.equal(details.mcpUrl, "http://127.0.0.1:8787/mcp");
	assert.match(details.prompt, /^Connect this agent to my Lix workspace\./);
	assert.match(details.prompt, /Name: LixRay Dev/);
	assert.match(details.prompt, /Do not reuse a production LixRay connection/);
	assert.match(details.prompt, /Call list_lixes/);
});

void test("uses LixRay in production and asks before ingesting recent context", () => {
	const details = createLixConnectionDetails({
		...lix,
		origin: "https://app.lixray.com",
	});

	assert.equal(details.serverName, "LixRay");
	assert.equal(details.documentationUrl, "https://app.lixray.com/docs/mcp");
	assert.doesNotMatch(details.prompt, /local development Lix/);
	assert.match(details.prompt, /skills or agent instructions I recently used/);
	assert.match(details.prompt, /especially knowledge-base content/);
	assert.match(
		details.prompt,
		/Do not ingest, create, or modify anything until I confirm/,
	);
});
