import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import {
	authErrorTelemetryProperties,
	isOrphanedAuthError,
	loadValidatedInitialSession,
	observeInitialSession,
	orphanedSessionSignInUrl,
	refreshBrowserSession,
	signOutBrowserSession,
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

async function browserAuthFixture(fetch: typeof globalThis.fetch) {
	const storageKey = "browser-auth-test";
	const session: Session = {
		...cachedSession,
		token_type: "bearer",
		expires_in: 3600,
		expires_at: Math.floor(Date.now() / 1000) + 3600,
	};
	const stored = new Map([[storageKey, JSON.stringify(session)]]);
	const { auth } = createClient("https://auth.example.test", "test-key", {
		auth: {
			storageKey,
			storage: {
				getItem: (key) => stored.get(key) ?? null,
				setItem: (key, value) => {
					stored.set(key, value);
				},
				removeItem: (key) => {
					stored.delete(key);
				},
			},
			persistSession: true,
			autoRefreshToken: false,
			detectSessionInUrl: false,
		},
		global: { fetch },
	});
	await auth.initialize();
	let visibleSession: Session | null = session;
	const events: string[] = [];
	const { data } = auth.onAuthStateChange((event, nextSession) => {
		if (event === "INITIAL_SESSION") return;
		events.push(event);
		visibleSession = nextSession;
	});
	return {
		auth,
		session,
		stored,
		storageKey,
		events,
		visibleSession: () => visibleSession,
		unsubscribe: () => data.subscription.unsubscribe(),
	};
}

void test("temporary refresh failure preserves login and a later refresh recovers", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	let fail = true;
	let requests = 0;
	const fixture = await browserAuthFixture(async () => {
		requests++;
		if (fail) {
			// Exhaust the SDK retry window without spending wall-clock time.
			t.mock.timers.tick(31_000);
			return new Response("temporarily unavailable", { status: 503 });
		}
		return Response.json({
			...fixture.session,
			access_token: "rotated-access-token",
			refresh_token: "rotated-refresh-token",
		});
	});
	t.after(fixture.unsubscribe);
	await assert.rejects(refreshBrowserSession(fixture.auth), { status: 503 });
	assert.equal(requests, 1);
	assert.deepEqual(fixture.visibleSession(), fixture.session);
	assert.deepEqual(fixture.events, []);
	assert.equal(
		(JSON.parse(fixture.stored.get(fixture.storageKey)!) as Session)
			.refresh_token,
		fixture.session.refresh_token,
	);

	fail = false;
	t.mock.timers.tick(60_000);
	await refreshBrowserSession(fixture.auth);
	assert.deepEqual(fixture.events, ["TOKEN_REFRESHED"]);
	assert.equal(fixture.visibleSession()?.access_token, "rotated-access-token");
	assert.equal(
		(JSON.parse(fixture.stored.get(fixture.storageKey)!) as Session)
			.refresh_token,
		"rotated-refresh-token",
	);
});

void test("terminal refresh failure still clears an expired login via SIGNED_OUT", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const fixture = await browserAuthFixture(async () =>
		Response.json(
			{
				code: "refresh_token_not_found",
				message: "Invalid refresh token",
			},
			{ status: 400 },
		),
	);
	t.after(fixture.unsubscribe);
	t.mock.timers.tick(3_601_000);
	await assert.rejects(refreshBrowserSession(fixture.auth), { status: 400 });
	assert.deepEqual(fixture.events, ["SIGNED_OUT"]);
	assert.equal(fixture.visibleSession(), null);
	assert.equal(fixture.stored.has(fixture.storageKey), false);
});

void test("browser sign-out revokes only the current session and updates login state", async (t) => {
	const requests: URL[] = [];
	const fixture = await browserAuthFixture(async (input) => {
		requests.push(new URL(input instanceof Request ? input.url : input));
		return new Response(null, { status: 204 });
	});
	t.after(fixture.unsubscribe);
	await signOutBrowserSession(fixture.auth);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.pathname, "/auth/v1/logout");
	assert.equal(requests[0]?.searchParams.get("scope"), "local");
	assert.deepEqual(fixture.events, ["SIGNED_OUT"]);
	assert.equal(fixture.visibleSession(), null);
	assert.equal(fixture.stored.has(fixture.storageKey), false);
});

void test("cold-start refresh outage stays indeterminate and recovers without a login", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	let fail = true;
	const fixture = await browserAuthFixture(async (input) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.pathname.endsWith("/user")) return Response.json(cachedUser);
		if (fail) {
			t.mock.timers.tick(31_000);
			return new Response("temporarily unavailable", { status: 503 });
		}
		return Response.json({
			...fixture.session,
			access_token: "recovered-token",
		});
	});
	t.after(fixture.unsubscribe);
	t.mock.timers.tick(3_601_000);
	let notify = () => {};
	let nextResult = new Promise<void>((resolve) => {
		notify = resolve;
	});
	const results: Awaited<ReturnType<typeof loadValidatedInitialSession>>[] = [];
	const stop = observeInitialSession(fixture.auth, (result) => {
		results.push(result);
		notify();
	});
	t.after(stop);
	await nextResult;
	assert.equal(results[0]?.kind, "validation_failed");
	assert.equal(
		results[0]?.kind === "validation_failed" && results[0].session,
		undefined,
	);
	assert.equal(fixture.stored.has(fixture.storageKey), true);
	assert.deepEqual(fixture.events, []);

	fail = false;
	nextResult = new Promise<void>((resolve) => {
		notify = resolve;
	});
	t.mock.timers.tick(60_000);
	await nextResult;
	assert.equal(results[1]?.kind, "authenticated");
	assert.equal(fixture.visibleSession()?.access_token, "recovered-token");
});

void test("initial validation retries back off to 30 seconds and cleanup cancels retries", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const stop = observeInitialSession(
		{
			getSession: async () => {
				calls++;
				return {
					data: { session: null },
					error: new TypeError("fetch failed"),
				};
			},
			getUser: async () => {
				throw new Error("must not query user");
			},
		},
		() => {},
	);
	t.after(stop);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
		const before: number = calls;
		t.mock.timers.tick(delay - 1);
		assert.equal(calls, before);
		t.mock.timers.tick(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, before + 1);
	}
	stop();
	const before: number = calls;
	t.mock.timers.tick(60_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, before);
});

void test("cancelling initial validation ignores a stale result after an auth event", async () => {
	let resolveSession!: (value: {
		data: { session: Session | null };
		error: null;
	}) => void;
	const sessionResponse = new Promise<{
		data: { session: Session | null };
		error: null;
	}>((resolve) => {
		resolveSession = resolve;
	});
	let results = 0;
	const stop = observeInitialSession(
		{
			getSession: () => sessionResponse,
			getUser: async () => ({ data: { user: cachedUser }, error: null }),
		},
		() => {
			results++;
		},
	);
	stop();
	resolveSession({ data: { session: cachedSession }, error: null });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(results, 0);
});
