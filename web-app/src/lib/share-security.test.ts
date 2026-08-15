import assert from "node:assert/strict";
import test from "node:test";
import { withShareSecurityHeaders } from "./share-security.ts";

void test("share responses never forward a referrer", async () => {
	const response = withShareSecurityHeaders(
		new Response("repository", {
			status: 200,
			headers: { "Referrer-Policy": "same-origin" },
		}),
	);

	assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
	assert.equal(await response.text(), "repository");
});
