import assert from "node:assert/strict";
import test from "node:test";
import type { Lix, LixOpenProgress } from "@lix-js/sdk";
import {
	createTelemetryFetch,
	fetchRepositoryRemoteSnapshot,
	isRetryableRepositoryOpenError,
	RemoteRepositoryLixSession,
	repositoryMigrationStateFromError,
	repositoryMigrationStateFromOpenProgress,
	repositorySessionKey,
	retryRepositoryOpenDuringMigration,
} from "./repository-lix-session.ts";

void test("downloads remote snapshots from the canonical protocol route", async () => {
	let request: Request | undefined;
	const snapshot = await fetchRepositoryRemoteSnapshot({
		namespace: "acme",
		repositorySlug: "docs",
		repositoryId: "11111111-1111-4111-8111-111111111111",
		origin: "https://lixray.test",
		getAccessToken: async () => "access-token",
		authIdentity: "user-123",
		fetch: async (input, init) => {
			request = new Request(input, init);
			return new Response(new Uint8Array([0x4c, 0x49, 0x58]), {
				headers: { "content-type": "application/vnd.lix.snapshot" },
			});
		},
	});

	assert.ok(request);
	assert.equal(
		new URL(request.url).pathname,
		"/lix/v1/11111111-1111-4111-8111-111111111111/snapshot",
	);
	assert.equal(request.headers.get("authorization"), "Bearer access-token");
	assert.deepEqual(
		new Uint8Array(await snapshot.arrayBuffer()),
		new Uint8Array([0x4c, 0x49, 0x58]),
	);
});

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
	const session = new RemoteRepositoryLixSession(lix, "main");
	assert.equal(observerCalls, 0);
	await session.close();
	assert.equal(closeCalls, 1);
});

void test("retries only transient repository-open transport failures", () => {
	assert.equal(
		isRetryableRepositoryOpenError(new TypeError("Failed to fetch")),
		true,
	);
	assert.equal(
		isRetryableRepositoryOpenError(
			new Error("browser sync fetch failed: Failed to fetch"),
		),
		true,
	);
	const aborted = new Error("The operation was aborted");
	aborted.name = "AbortError";
	assert.equal(isRetryableRepositoryOpenError(aborted), true);
	assert.equal(
		isRetryableRepositoryOpenError(
			new Error("browser sync fetch failed: The operation was aborted"),
		),
		true,
	);
	assert.equal(
		isRetryableRepositoryOpenError(
			Object.assign(new Error("The replica is recovering"), {
				code: "LIX_ERROR_LIX_RECOVERING",
			}),
		),
		true,
	);

	assert.equal(
		isRetryableRepositoryOpenError(
			Object.assign(new Error("unrelated internal failure"), {
				code: "LIX_INTERNAL_ERROR",
			}),
		),
		false,
	);
	assert.equal(
		isRetryableRepositoryOpenError(new Error("request failed with status 500")),
		false,
	);
	assert.equal(
		isRetryableRepositoryOpenError(new Error("Failed to fetch repository row")),
		false,
	);
});

void test("reads structured repository migration state from an open error", () => {
	assert.deepEqual(
		repositoryMigrationStateFromError(
			Object.assign(new Error("The lix repository is being migrated."), {
				code: "LIX_ERROR_LIX_MIGRATING",
				details: { fromVersion: 68, toVersion: 71, retryable: true },
			}),
		),
		{ fromVersion: 68, toVersion: 71 },
	);
	assert.equal(
		repositoryMigrationStateFromError(
			Object.assign(new Error("Malformed migration state"), {
				code: "LIX_ERROR_LIX_MIGRATING",
				details: { fromVersion: "68", toVersion: 71 },
			}),
		),
		null,
	);
	assert.equal(
		repositoryMigrationStateFromError(
			Object.assign(new Error("The replica is recovering"), {
				code: "LIX_ERROR_LIX_RECOVERING",
			}),
		),
		null,
	);
});

void test("maps Rust-first open progress into transparent repository upgrade UI state", () => {
	const progress = (
		phase: LixOpenProgress["phase"],
		fromFormat?: number,
	): LixOpenProgress => ({
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

void test("polls migration in one open lifecycle until the repository is ready", async () => {
	let opens = 0;
	const waits: number[] = [];
	const states: Array<{ fromVersion: number; toVersion: number } | null> = [];
	const session = await retryRepositoryOpenDuringMigration({
		open: async () => {
			opens += 1;
			if (opens < 3) throw migrationError();
			return "ready";
		},
		onMigration: (state) => states.push(state),
		wait: async (milliseconds) => {
			waits.push(milliseconds);
		},
	});

	assert.equal(session, "ready");
	assert.equal(opens, 3);
	assert.deepEqual(waits, [1_000, 1_000]);
	assert.deepEqual(states, [
		{ fromVersion: 68, toVersion: 71 },
		{ fromVersion: 68, toVersion: 71 },
		null,
	]);
});

void test("stops polling and clears progress when its owner aborts", async () => {
	const controller = new AbortController();
	let opens = 0;
	const states: Array<{ fromVersion: number; toVersion: number } | null> = [];
	await assert.rejects(
		retryRepositoryOpenDuringMigration({
			open: async () => {
				opens += 1;
				throw migrationError();
			},
			onMigration: (state) => states.push(state),
			signal: controller.signal,
			wait: async (_milliseconds, signal) => {
				controller.abort();
				signal?.throwIfAborted();
			},
		}),
		{ name: "AbortError" },
	);
	assert.equal(opens, 1);
	assert.deepEqual(states, [{ fromVersion: 68, toVersion: 71 }, null]);
});

function migrationError(): Error {
	return Object.assign(new Error("The lix repository is being migrated."), {
		code: "LIX_ERROR_LIX_MIGRATING",
		details: { fromVersion: 68, toVersion: 71, retryable: true },
	});
}

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
		Response.json(
			{ error: { code: "LIX_ERROR_LIX_MIGRATING" } },
			{ status: 503 },
		),
		Response.json(
			{ error: { code: "LIX_ERROR_LIX_RECOVERING" } },
			{ status: 503 },
		),
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
