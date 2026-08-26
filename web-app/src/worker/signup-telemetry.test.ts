import assert from "node:assert/strict";
import test from "node:test";
import {
	captureUserSignedUp,
	isSignupTelemetryEligible,
	USER_SIGNED_UP_EVENT,
} from "./signup-telemetry.ts";

const USER_ID = "95a017ae-6b39-4acc-ba13-f9bfec4c5e6e";
const AUTH_USER_ID = "85b55493-0b11-4aaa-b148-c8acbcf18ef6";
const NOW = Date.parse("2026-08-26T15:05:00.000Z");

void test("signup capture remains retryable for every post-cutover account", () => {
	assert.equal(
		isSignupTelemetryEligible({ created_at: "2026-08-26T15:00:00.000Z" }, NOW),
		true,
	);
	assert.equal(
		isSignupTelemetryEligible(
			{ created_at: "2026-08-26T00:00:00.000Z" },
			Date.parse("2026-09-26T15:05:00.000Z"),
		),
		true,
	);
	assert.equal(
		isSignupTelemetryEligible({ created_at: "2026-08-25T23:59:59.999Z" }, NOW),
		false,
	);
	assert.equal(
		isSignupTelemetryEligible({ created_at: "invalid" }, NOW),
		false,
	);
});

void test("server capture identifies the person then emits the canonical signup event", async () => {
	const identifies: Array<unknown> = [];
	const events: Array<unknown> = [];
	const lifecycle: Array<string> = [];
	const result = await captureUserSignedUp(
		productionEnv(),
		{ userId: USER_ID, authUserId: AUTH_USER_ID, token: "access-token" },
		{ surface: "mcp", source: "oauth" },
		{
			now: () => NOW,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, "https://project.supabase.co/auth/v1/user");
				assert.equal(request.headers.get("apikey"), "publishable-key");
				assert.equal(
					request.headers.get("authorization"),
					"Bearer access-token",
				);
				return Response.json({
					id: AUTH_USER_ID,
					email: "new@example.com",
					created_at: "2026-08-26T15:00:00.000Z",
					app_metadata: { provider: "google" },
					user_metadata: { full_name: "New User" },
				});
			},
			createClient: (_token, options) => {
				assert.equal(_token, "posthog-token");
				assert.equal(options.host, "https://us.i.posthog.com");
				return {
					identify(message) {
						identifies.push(message);
					},
					async flush() {
						lifecycle.push("flush");
					},
					async captureImmediate(event) {
						lifecycle.push("capture");
						events.push(event);
					},
					async shutdown() {
						lifecycle.push("shutdown");
					},
				};
			},
		},
	);

	assert.equal(result, "captured");
	assert.deepEqual(identifies, [
		{
			distinctId: USER_ID,
			properties: { email: "new@example.com", name: "New User" },
		},
	]);
	assert.deepEqual(events, [
		{
			distinctId: USER_ID,
			event: USER_SIGNED_UP_EVENT,
			uuid: USER_ID,
			timestamp: new Date("2026-08-26T15:00:00.000Z"),
			properties: {
				email: "new@example.com",
				name: "New User",
				auth_provider: "google",
				surface: "mcp",
				signup_source: "oauth",
				environment: "production",
			},
		},
	]);
	assert.deepEqual(lifecycle, ["flush", "capture", "shutdown"]);
});

void test("existing users do not emit another signup", async () => {
	let createdClient = false;
	const result = await captureUserSignedUp(
		productionEnv(),
		{ userId: USER_ID, token: "access-token" },
		{ surface: "web", source: "direct" },
		{
			now: () => NOW,
			fetch: async () =>
				Response.json({
					id: USER_ID,
					created_at: "2026-08-20T15:00:00.000Z",
				}),
			createClient: () => {
				createdClient = true;
				throw new Error("must not create PostHog client");
			},
		},
	);
	assert.equal(result, "not_new");
	assert.equal(createdClient, false);
});

function productionEnv() {
	return {
		SUPABASE_URL: "https://project.supabase.co",
		SUPABASE_PUBLISHABLE_KEY: "publishable-key",
		POSTHOG_PROJECT_TOKEN: "posthog-token",
		POSTHOG_ENVIRONMENT: "production",
	};
}
