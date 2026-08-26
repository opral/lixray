import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { EventMessage } from "posthog-node";
import {
	USER_SIGNED_UP_EVENT,
	maybeCaptureUserSignedUp,
	resetUserSignupClaimCacheForTests,
	shouldCaptureUserSignedUp,
	userSignedUpProperties,
	type SignupClaim,
	type UserSignupEnv,
} from "./user-signup-telemetry.ts";

const productionEnv: UserSignupEnv = {
	POSTHOG_PROJECT_TOKEN: "phc_test_token",
	POSTHOG_HOST: "https://posthog.example",
	POSTHOG_ENVIRONMENT: "production",
	SUPABASE_URL: "https://supabase.example",
	SUPABASE_PUBLISHABLE_KEY: "publishable-key",
};

const firstClaim: SignupClaim = {
	claimed: true,
	email: "new-user@example.com",
	name: "New User",
};

void test("signup properties always include identity email and name", () => {
	assert.deepEqual(
		userSignedUpProperties({
			email: "  new-user@example.com  ",
			name: " New User ",
			signupSource: "mcp",
		}),
		{
			email: "new-user@example.com",
			name: "New User",
			signup_source: "mcp",
		},
	);
});

void test("production accounts are eligible and demo accounts are not", () => {
	assert.equal(
		shouldCaptureUserSignedUp(productionEnv, { isDemo: false }),
		true,
	);
	assert.equal(shouldCaptureUserSignedUp(productionEnv, { isDemo: true }), false);
	assert.equal(
		shouldCaptureUserSignedUp(
			{ ...productionEnv, LIXRAY_DEMO: "1" },
			{ isDemo: false },
		),
		false,
	);
	assert.equal(
		shouldCaptureUserSignedUp(
			{ ...productionEnv, POSTHOG_ENVIRONMENT: "preview" },
			{ isDemo: false },
		),
		false,
	);
});

void test("first account creation captures lixray_user_signed_up once with email and name", async () => {
	resetUserSignupClaimCacheForTests();
	const captures: EventMessage[] = [];
	let claims = 0;

	const first = await maybeCaptureUserSignedUp(
		productionEnv,
		{ userId: "user-1", token: "token-1" },
		"mcp",
		{
			claim: async () => {
				claims += 1;
				return firstClaim;
			},
			createClient: () => ({
				captureImmediate: async (event) => {
					captures.push(event);
				},
				shutdown: async () => undefined,
			}),
		},
	);
	const second = await maybeCaptureUserSignedUp(
		productionEnv,
		{ userId: "user-1", token: "token-1" },
		"mcp",
		{
			claim: async () => {
				claims += 1;
				return { claimed: false, email: firstClaim.email, name: firstClaim.name };
			},
			createClient: () => ({
				captureImmediate: async (event) => {
					captures.push(event);
				},
				shutdown: async () => undefined,
			}),
		},
	);

	assert.equal(first, "captured");
	assert.equal(second, "already_captured");
	assert.equal(claims, 1, "the process cache must not recapture the same account");
	assert.deepEqual(captures, [
		{
			distinctId: "user-1",
			event: USER_SIGNED_UP_EVENT,
			properties: {
				email: "new-user@example.com",
				name: "New User",
				signup_source: "mcp",
			},
		},
	]);
	assert.equal(captures[0]?.event, "lixray_user_signed_up");
	assert.equal(typeof captures[0]?.properties?.email, "string");
	assert.ok(String(captures[0]?.properties?.email).length > 0);
	assert.equal(typeof captures[0]?.properties?.name, "string");
	assert.ok(String(captures[0]?.properties?.name).length > 0);
});

void test("a returning login whose claim is already taken does not emit", async () => {
	resetUserSignupClaimCacheForTests();
	const captures: EventMessage[] = [];

	const result = await maybeCaptureUserSignedUp(
		productionEnv,
		{ userId: "user-2", token: "token-2" },
		"web",
		{
			claim: async () => ({
				claimed: false,
				email: "returning@example.com",
				name: "Returning User",
			}),
			createClient: () => ({
				captureImmediate: async (event) => {
					captures.push(event);
				},
				shutdown: async () => undefined,
			}),
		},
	);

	assert.equal(result, "already_captured");
	assert.deepEqual(captures, []);
});

void test("web and MCP first-create paths both emit the account event", async () => {
	resetUserSignupClaimCacheForTests();
	const captures: EventMessage[] = [];
	const claimFor = (userId: string): SignupClaim => ({
		claimed: true,
		email: `${userId}@example.com`,
		name: userId,
	});

	for (const [userId, source] of [
		["web-user", "web"],
		["mcp-user", "mcp"],
	] as const) {
		const result = await maybeCaptureUserSignedUp(
			productionEnv,
			{ userId, token: `${userId}-token` },
			source,
			{
				claim: async () => claimFor(userId),
				createClient: () => ({
					captureImmediate: async (event) => {
						captures.push(event);
					},
					shutdown: async () => undefined,
				}),
			},
		);
		assert.equal(result, "captured", source);
	}

	assert.deepEqual(
		captures.map((event) => ({
			distinctId: event.distinctId,
			event: event.event,
			email: event.properties?.email,
			name: event.properties?.name,
			signup_source: event.properties?.signup_source,
		})),
		[
			{
				distinctId: "web-user",
				event: "lixray_user_signed_up",
				email: "web-user@example.com",
				name: "web-user",
				signup_source: "web",
			},
			{
				distinctId: "mcp-user",
				event: "lixray_user_signed_up",
				email: "mcp-user@example.com",
				name: "mcp-user",
				signup_source: "mcp",
			},
		],
	);
});

void test("signup is not a webapp_* emit and the callback no longer captures it", async () => {
	const [callback, telemetryDocs] = await Promise.all([
		readFile(new URL("../routes/auth.callback.tsx", import.meta.url), "utf8"),
		readFile(new URL("../../../docs/sql-telemetry.md", import.meta.url), "utf8"),
	]);

	assert.doesNotMatch(callback, /webapp_user_signed_up/);
	assert.doesNotMatch(callback, /lixray_user_signed_up/);
	assert.doesNotMatch(callback, /lixray\.signup\./);
	assert.doesNotMatch(callback, /captureTelemetryImmediately/);
	assert.doesNotMatch(
		telemetryDocs,
		/lixray_user_signed_up\s*\|\s*webapp_user_signed_up/,
	);
	assert.match(telemetryDocs, /lixray_user_signed_up/);
});
