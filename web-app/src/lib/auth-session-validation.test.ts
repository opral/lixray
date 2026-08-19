import assert from "node:assert/strict";
import test from "node:test";
import type { Session, User } from "@supabase/supabase-js";
import {
	authErrorTelemetryProperties,
	isOrphanedAuthError,
	loadValidatedInitialSession,
	orphanedSessionSignInUrl,
} from "./auth-session-validation.ts";

const cachedUser = { id: "cached-user" } as User;
const validatedUser = { id: "validated-user" } as User;
const cachedSession = {
	access_token: "secret-access-token",
	refresh_token: "secret-refresh-token",
	user: cachedUser,
} as Session;

void test("server-validates and replaces the cached session user", async () => {
	const result = await loadValidatedInitialSession({
		getSession: async () => ({
			data: { session: cachedSession },
			error: null,
		}),
		getUser: async () => ({
			data: { user: validatedUser },
			error: null,
		}),
	});

	assert.equal(result.kind, "authenticated");
	if (result.kind === "authenticated") {
		assert.equal(result.session.user, validatedUser);
		assert.equal(result.session.access_token, "secret-access-token");
	}
});

void test("classifies a deleted persisted user as orphaned", async () => {
	const authError = {
		status: 403,
		code: "user_not_found",
		message: "User from sub claim in JWT does not exist",
	};
	const result = await loadValidatedInitialSession({
		getSession: async () => ({
			data: { session: cachedSession },
			error: null,
		}),
		getUser: async () => ({ data: { user: null }, error: authError }),
	});

	assert.deepEqual(result, { kind: "orphaned", error: authError });
});

void test("does not destroy a session for an indeterminate network failure", async () => {
	const networkError = new TypeError("fetch failed");
	const result = await loadValidatedInitialSession({
		getSession: async () => ({
			data: { session: cachedSession },
			error: null,
		}),
		getUser: async () => ({ data: { user: null }, error: networkError }),
	});

	assert.deepEqual(result, {
		kind: "validation_failed",
		error: networkError,
		session: cachedSession,
	});
	assert.equal(isOrphanedAuthError(networkError), false);
});

void test("does not call the user endpoint without a persisted session", async () => {
	let userLookupCalled = false;
	const result = await loadValidatedInitialSession({
		getSession: async () => ({ data: { session: null }, error: null }),
		getUser: async () => {
			userLookupCalled = true;
			return { data: { user: null }, error: null };
		},
	});

	assert.deepEqual(result, { kind: "signed_out" });
	assert.equal(userLookupCalled, false);
});

void test("auth telemetry retains only stable error fields", () => {
	const properties = authErrorTelemetryProperties({
		status: 403,
		code: "user_not_found",
		message: "secret response body",
		authorization: "Bearer secret.jwt.value",
	});

	assert.deepEqual(properties, {
		auth_error_code: "user_not_found",
		auth_error_status: 403,
	});
	assert.doesNotMatch(
		JSON.stringify(properties),
		/secret|Bearer|response body/,
	);
});

void test("builds a sign-in URL without exposing auth data", () => {
	assert.equal(
		orphanedSessionSignInUrl("/home?tab=recent"),
		"/sign-in?returnTo=%2Fhome%3Ftab%3Drecent",
	);
});
