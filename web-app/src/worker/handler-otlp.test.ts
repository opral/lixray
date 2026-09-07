import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./handler.ts";

const endpoint = "https://example.test/api/telemetry/otlp/v1/traces";

void test("OTLP route rejects missing service credentials before user auth or app fallback", async () => {
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: new Uint8Array(),
		}),
		{ LIXRAY_INTERNAL_TOKEN: "internal-token" },
		{
			authenticate: () => {
				assert.fail("OTLP must not use browser authentication");
			},
			fallback: () => {
				assert.fail("OTLP must not fall through to the app");
			},
		},
	);
	assert.equal(response.status, 401);
});

void test("OTLP route authenticates service credentials independently of browser sessions", async () => {
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer internal-token",
				"content-type": "application/x-protobuf",
			},
			body: new Uint8Array([255]),
		}),
		{
			LIXRAY_INTERNAL_TOKEN: "internal-token",
			POSTHOG_PROJECT_TOKEN: "phc_test",
			POSTHOG_ENVIRONMENT: "production",
		},
		{
			authenticate: () => {
				assert.fail("OTLP must not use browser authentication");
			},
			fallback: () => {
				assert.fail("OTLP must not fall through to the app");
			},
		},
	);
	assert.equal(response.status, 400);
});
