import assert from "node:assert/strict";
import test from "node:test";
import {
	createTelemetryFetch,
	isRetryableRepositoryOpenError,
	repositorySessionKey,
} from "./repository-lix-session.ts";

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
