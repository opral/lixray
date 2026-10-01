import assert from "node:assert/strict";
import test from "node:test";
import type { Lix, LixOpenProgress } from "@lix-js/sdk";
import {
	createTelemetryFetch,
	isRetryableRepositoryOpenError,
	ManagedRepositoryLixSession,
	repositoryMigrationStateFromOpenProgress,
	repositorySessionKey,
} from "./repository-lix-session.ts";

void test("does not create a synthetic observer for session health", async () => {
	let observerCalls = 0;
	let closeCalls = 0;
	const lix = {
		observe: () => {
			observerCalls += 1;
			throw new Error("session construction must not observe");
		},
		close: async () => {
			closeCalls += 1;
		},
	} as unknown as Lix;
	const session = new ManagedRepositoryLixSession(lix, "main");
	assert.equal(observerCalls, 0);
	await session.close();
	assert.equal(closeCalls, 1);
});

void test("maps Rust-first open progress into transparent repository upgrade UI state", () => {
	const progress = (
		phase: LixOpenProgress["phase"],
		fromFormat?: number,
	): LixOpenProgress => ({
		scope: "local",
		phase,
		fromFormat,
		toFormat: 76,
	});

	assert.deepEqual(
		repositoryMigrationStateFromOpenProgress(progress("migrating", 75)),
		{ fromVersion: 75, toVersion: 76, phase: "migrating" },
	);
	assert.deepEqual(
		repositoryMigrationStateFromOpenProgress(progress("validating", 75)),
		{ fromVersion: 75, toVersion: 76, phase: "validating" },
	);
	assert.deepEqual(
		repositoryMigrationStateFromOpenProgress(progress("opening", 75)),
		{ fromVersion: 75, toVersion: 76, phase: "opening" },
	);
	assert.equal(
		repositoryMigrationStateFromOpenProgress(progress("inspecting")),
		undefined,
	);
	assert.equal(
		repositoryMigrationStateFromOpenProgress(progress("complete", 75)),
		null,
	);
});

void test("refreshes an expired access token and retries a sync request once", async () => {
	let refreshCalls = 0;
	let attempts = 0;
	const captured: unknown[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(new URL(input, "https://lixray.test"), init);
		attempts += 1;
		if (attempts === 1) {
			assert.equal(
				request.headers.get("authorization"),
				"Bearer expired-token",
			);
			return new Response("Unauthorized\n", { status: 401 });
		}
		assert.equal(request.headers.get("authorization"), "Bearer fresh-token");
		return Response.json({ ok: true });
	};

	const authenticatedFetch = createTelemetryFetch(
		fetch,
		{
			repositoryId: "repo-id",
			refreshAccessToken: async () => {
				refreshCalls += 1;
				return "fresh-token";
			},
		},
		{ captureException: (error) => captured.push(error) },
	);
	const response = await authenticatedFetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull",
		{
			method: "GET",
			headers: { Authorization: "Bearer expired-token" },
		},
	);

	assert.equal(response.status, 200);
	assert.equal(refreshCalls, 1);
	assert.equal(attempts, 2);
	assert.deepEqual(captured, []);
});

void test("captures a terminal request failure as one structured exception", async () => {
	const captured: Array<{
		error: unknown;
		properties: Record<string, unknown> | undefined;
	}> = [];
	const fetch = createTelemetryFetch(
		async () =>
			Response.json(
				{
					error: {
						code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
						message: "private repository content must not be captured",
					},
				},
				{ status: 410 },
			),
		{ repositoryId: "repo-id" },
		{
			captureException: (error, properties) => {
				captured.push({ error, properties });
			},
		},
	);

	const response = await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull",
		{ method: "GET" },
	);

	assert.equal(response.status, 410);
	assert.equal(captured.length, 1);
	assert.ok(captured[0]?.error instanceof Error);
	assert.equal(captured[0].error.name, "LixRequestError");
	assert.equal(
		captured[0].error.message,
		"GET sync failed with HTTP 410 (LIX_ERROR_PROTOCOL_SESSION_GONE)",
	);
	assert.deepEqual(captured[0].properties, {
		operation: "repository_request",
		lix_request_endpoint: "sync",
		http_route: "/lix/v1/{lix_id}/sync/pull",
		lix_request_method: "GET",
		lix_http_status: 410,
		lix_error_code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
		lix_id: "repo-id",
	});
	assert.doesNotMatch(
		JSON.stringify(captured[0].properties),
		/private repository content/,
	);
});

void test("deduplicates repeated request failures until the request recovers", async () => {
	let shouldFail = true;
	const captured: unknown[] = [];
	const fetch = createTelemetryFetch(
		async () =>
			shouldFail
				? Response.json(
						{ error: { code: "LIX_ERROR_PROTOCOL_SESSION_GONE" } },
						{ status: 410 },
					)
				: Response.json({ ok: true }),
		{ repositoryId: "repo-id" },
		{ captureException: (error) => captured.push(error) },
	);
	const url =
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull";

	await fetch(url);
	await fetch(url);
	await fetch(url);
	assert.equal(captured.length, 1);

	shouldFail = false;
	await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/chunk",
	);
	shouldFail = true;
	await fetch(url);
	assert.equal(captured.length, 1);

	shouldFail = false;
	await fetch(url);
	shouldFail = true;
	await fetch(url);
	assert.equal(captured.length, 2);
});

void test("does not report expected migration, recovery, or missing-chunk responses", async () => {
	const captured: unknown[] = [];
	const responses = [
		Response.json({ error: { code: "LIX_ERROR_MIGRATING" } }, { status: 503 }),
		Response.json({ error: { code: "LIX_ERROR_RECOVERING" } }, { status: 503 }),
		new Response(null, { status: 404 }),
	];
	const fetch = createTelemetryFetch(
		async () => {
			const response = responses.shift();
			assert.ok(response);
			return response;
		},
		{ repositoryId: "repo-id" },
		{ captureException: (error) => captured.push(error) },
	);

	await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull",
	);
	await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull",
	);
	await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/chunk",
	);

	assert.deepEqual(captured, []);
});

void test("leaves repository-open failures to their terminal exception boundary", async () => {
	const captured: unknown[] = [];
	const fetch = createTelemetryFetch(
		async () =>
			Response.json({ error: { code: "LIX_INTERNAL_ERROR" } }, { status: 500 }),
		{
			repositoryId: "repo-id",
			shouldCaptureRequestFailures: () => false,
		},
		{ captureException: (error) => captured.push(error) },
	);

	const response = await fetch(
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/",
	);

	assert.equal(response.status, 500);
	assert.deepEqual(captured, []);
});

void test("captures unexpected network failures but ignores canceled requests", async () => {
	const captured: unknown[] = [];
	const networkError = new TypeError("Failed to fetch");
	const failingFetch = createTelemetryFetch(
		async () => {
			throw networkError;
		},
		{ repositoryId: "repo-id" },
		{ captureException: (error) => captured.push(error) },
	);
	const url =
		"https://lixray.test/lix/v1/11111111-1111-4111-8111-111111111111/sync/pull";

	await assert.rejects(failingFetch(url), networkError);
	await assert.rejects(failingFetch(url), networkError);
	assert.equal(captured.length, 1);
	assert.equal(captured[0], networkError);

	const controller = new AbortController();
	controller.abort();
	const canceledFetch = createTelemetryFetch(
		async () => {
			throw new DOMException("The operation was aborted.", "AbortError");
		},
		{ repositoryId: "repo-id", signal: controller.signal },
		{ captureException: (error) => captured.push(error) },
	);
	await assert.rejects(canceledFetch(url), { name: "AbortError" });
	assert.deepEqual(captured, [networkError]);
});

void test("isolates managed sessions when the signed-in identity changes", () => {
	const repository = {
		namespace: "opral",
		repositorySlug: "monorepo",
		repositoryId: "repository-id",
		origin: "https://lixray.test",
		replicaId: "shared-browser",
		getAccessToken: async () => null,
		authIdentity: "user-samuel",
	};

	assert.notEqual(
		repositorySessionKey({
			...repository,
			authIdentity: "public:acc2bc33",
		}),
		repositorySessionKey({ ...repository, authIdentity: "user-samuel" }),
	);
});

void test("isolates managed sessions when a slug is recreated", () => {
	const repository = {
		namespace: "opral",
		repositorySlug: "monorepo",
		repositoryId: "repository-id",
		origin: "https://lixray.test",
		getAccessToken: async () => null,
		authIdentity: "user-samuel",
	};

	assert.notEqual(
		repositorySessionKey({ ...repository, repositoryId: "repository-before" }),
		repositorySessionKey({ ...repository, repositoryId: "repository-after" }),
	);
});

void test("expired handshake credentials refresh without provisioning", async () => {
	const tokens: string[] = [];
	const wrapped = createTelemetryFetch(
		async (input, init) => {
			const request = new Request(input, init);
			assert.equal(
				new URL(request.url).pathname,
				"/lix/v1/11111111-1111-4111-8111-111111111111/",
			);
			const token = request.headers.get("authorization") ?? "";
			tokens.push(token);
			return token === "Bearer refreshed"
				? Response.json({ ok: true })
				: new Response(null, { status: 401 });
		},
		{ repositoryId: "repository", refreshAccessToken: async () => "refreshed" },
		{
			captureException: () => {
				throw new Error("unexpected failure");
			},
		},
	);
	const response = await wrapped(
		new Request(
			"https://gateway.test/lix/v1/11111111-1111-4111-8111-111111111111/",
			{ headers: { authorization: "Bearer expired" } },
		),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(tokens, ["Bearer expired", "Bearer refreshed"]);
});

void test("only typed network failure, storage contention, and server recovery are retried by opening", () => {
	assert.equal(
		isRetryableRepositoryOpenError(
			Object.assign(new Error("offline"), { code: "LIX_TRANSPORT_NETWORK" }),
		),
		true,
	);
	assert.equal(
		isRetryableRepositoryOpenError({ code: "LIX_STORAGE_IN_USE" }),
		true,
	);
	assert.equal(
		isRetryableRepositoryOpenError({ code: "LIX_STORAGE_FENCED" }),
		true,
	);
	for (const details of [
		{ nonRetryableAfterCommit: true },
		{ nonRetryableAfterExecution: true },
	])
		assert.equal(
			isRetryableRepositoryOpenError({ code: "LIX_STORAGE_IN_USE", details }),
			false,
		);
	for (const code of [
		"LIX_STORAGE_CLOSED",
		"LIX_TRANSPORT_CONTRACT",
		"LIX_TRANSPORT_CALLBACK",
		"LIX_TRANSPORT_ABORTED",
		"LIX_STORAGE_READ_EXPIRED",
		"LIX_MIGRATION_REQUIRED",
		"LIX_ERROR_MIGRATING",
		"LIX_REPOSITORY_MIGRATING",
	])
		assert.equal(
			isRetryableRepositoryOpenError(
				Object.assign(new Error("failure"), { code }),
			),
			false,
		);
	assert.equal(
		isRetryableRepositoryOpenError(new TypeError("Failed to fetch")),
		false,
	);
	assert.equal(
		isRetryableRepositoryOpenError(
			Object.assign(new Error("completed"), {
				code: "LIX_TRANSPORT_NETWORK",
				details: { nonRetryableAfterCommit: true },
			}),
		),
		false,
	);
});

void test("authority upgrade transitions do not turn ordinary opening into an upgrade", () => {
	assert.equal(
		repositoryMigrationStateFromOpenProgress({
			phase: "opening",
			scope: "local",
			toFormat: 81,
		}),
		undefined,
	);
	assert.deepEqual(
		repositoryMigrationStateFromOpenProgress({
			phase: "opening",
			scope: "authority",
			toFormat: 81,
		}),
		{ fromVersion: undefined, toVersion: 81, phase: "opening" },
	);
});

void test("exhausted admission does not restart the SDK retry budget", () => {
	assert.equal(
		isRetryableRepositoryOpenError(
			Object.assign(new Error("offline"), {
				code: "LIX_TRANSPORT_NETWORK",
				details: { admissionRetryExhausted: true },
			}),
		),
		false,
	);
});
