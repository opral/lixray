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

void test("the Railway proxy translates its authenticated principal for the generic Lix server", () => {
	const headers = lixServiceRequestHeaders(
		new Headers({
			"x-lixray-idempotency-principal": "user-123",
			"x-lix-account-id": "spoofed-account",
			"x-lix-idempotency-scope": "spoofed-scope",
		}),
		"internal-token",
	);

	assert.equal(headers.get("x-lixray-idempotency-principal"), null);
	assert.equal(headers.get("x-lix-account-id"), "user-123");
	assert.equal(headers.get("x-lix-idempotency-scope"), "user-123");
});

void test("the Railway proxy preserves demo attribution without inventing a Lix account", () => {
	const headers = lixServiceRequestHeaders(
		new Headers({ "x-lixray-idempotency-principal": "lixray-demo" }),
		"internal-token",
	);

	assert.equal(
		headers.get("x-lix-account-id"),
		"00000000-0000-7000-8000-000000000002",
	);
	assert.equal(headers.get("x-lix-idempotency-scope"), "lixray-demo");
});
