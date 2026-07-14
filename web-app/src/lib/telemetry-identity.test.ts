import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeTelemetryIdentity } from "./telemetry-identity.ts";

function identityClient(persistedUserId?: string) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			get_property: (key: string) =>
				key === "$user_id" ? persistedUserId : undefined,
			identify: (userId: string) => calls.push(`identify:${userId}`),
			reset: () => calls.push("reset"),
		},
	};
}

void test("keeps a returning anonymous visitor anonymous", () => {
	const { calls, client } = identityClient();
	synchronizeTelemetryIdentity(client, null);
	assert.deepEqual(calls, []);
});

void test("resets a persisted user when Supabase is signed out", () => {
	const { calls, client } = identityClient("previous-user");
	synchronizeTelemetryIdentity(client, null);
	assert.deepEqual(calls, ["reset"]);
});

void test("identifies the current Supabase user", () => {
	const { calls, client } = identityClient();
	synchronizeTelemetryIdentity(client, "current-user");
	assert.deepEqual(calls, ["identify:current-user"]);
});

void test("does not identify the same persisted user twice", () => {
	const { calls, client } = identityClient("current-user");
	synchronizeTelemetryIdentity(client, "current-user");
	assert.deepEqual(calls, []);
});

void test("separates different authenticated users on a shared browser", () => {
	const { calls, client } = identityClient("previous-user");
	synchronizeTelemetryIdentity(client, "current-user");
	assert.deepEqual(calls, ["reset", "identify:current-user"]);
});
