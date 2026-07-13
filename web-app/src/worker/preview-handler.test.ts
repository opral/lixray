import assert from "node:assert/strict";
import test from "node:test";
import {
	handlePreviewRequest,
	isPreviewBackendPath,
	PREVIEW_UNAVAILABLE_MESSAGE,
} from "./preview-handler.ts";

void test("preview backend paths cover workspace, MCP, and OAuth discovery", () => {
	for (const path of [
		"/v1/workspaces/example/branches",
		"/mcp",
		"/mcp/docs",
		"/.well-known/oauth-protected-resource",
	]) {
		assert.equal(isPreviewBackendPath(path), true, path);
	}
	for (const path of ["/", "/sign-in", "/@acme/launch-q3"]) {
		assert.equal(isPreviewBackendPath(path), false, path);
	}
});

void test("preview backend requests return a deliberate 404", async () => {
	let fallbackCalled = false;
	const response = await handlePreviewRequest(
		new Request("https://preview.example/v1/workspaces/example/branches"),
		async () => {
			fallbackCalled = true;
			return new Response("fallback");
		},
	);

	assert.equal(response.status, 404);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(fallbackCalled, false);
	assert.deepEqual(await response.json(), {
		error: {
			code: "PREVIEW_BACKEND_UNAVAILABLE",
			message: PREVIEW_UNAVAILABLE_MESSAGE,
		},
	});
});

void test("preview frontend requests use the application fallback", async () => {
	const response = await handlePreviewRequest(
		new Request("https://preview.example/"),
		async () => new Response("frontend", { status: 200 }),
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "frontend");
});
