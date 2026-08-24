import assert from "node:assert/strict";
import test from "node:test";
import { lixServiceRequestHeaders } from "../lib/lix-service-proxy.ts";

void test("the Railway repository proxy requests an identity upstream body", () => {
	const headers = lixServiceRequestHeaders(
		new Headers({
			"accept-encoding": "gzip, deflate, br, zstd",
			"x-request-id": "request-id",
		}),
		"internal-token",
	);

	assert.equal(headers.get("accept-encoding"), "identity");
	assert.equal(headers.get("authorization"), "Bearer internal-token");
	assert.equal(headers.get("x-request-id"), "request-id");
});
