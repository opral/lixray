import assert from "node:assert/strict";
import test from "node:test";
import type { Lix } from "@lix-js/sdk";
import {
	createTelemetryFetch,
	isRetryableRepositoryOpenError,
	RemoteRepositoryLixSession,
	repositoryMigrationStateFromError,
	repositorySessionKey,
	retryRepositoryOpenDuringMigration,
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

	const authenticatedFetch = createTelemetryFetch(fetch, {
		repositoryId: "repo-id",
		refreshAccessToken: async () => {
			refreshCalls += 1;
			return "fresh-token";
		},
	});
	const response = await authenticatedFetch(
		"https://lixray.test/repos/acme/launch-q3/lix/v1/sync/pull",
		{
			method: "GET",
			headers: { Authorization: "Bearer expired-token" },
		},
	);

	assert.equal(response.status, 200);
	assert.equal(refreshCalls, 1);
	assert.equal(attempts, 2);
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
