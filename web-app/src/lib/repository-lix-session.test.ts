import assert from "node:assert/strict";
import test from "node:test";
import {
	createTelemetryFetch,
	isRetryableRepositoryOpenError,
	parseLixrayServerTiming,
	repositorySessionKey,
} from "./repository-lix-session.ts";

void test("isolates managed OPFS sessions by replica identity", () => {
	const repository = {
		namespace: "acme",
		repositorySlug: "launch-q3",
		origin: "https://lixray.test",
		replicaId: "shared-browser",
		authIdentity: "user-samuel",
		getAccessToken: async () => null,
	};

	assert.notEqual(
		repositorySessionKey({ ...repository, replicaId: "anonymous" }),
		repositorySessionKey({ ...repository, replicaId: "account-123" }),
	);
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

void test("parses the Lixray and Lix Server-Timing hard cut", () => {
	assert.deepEqual(
		parseLixrayServerTiming(
			"cache;desc=ignored, lixray-web-auth;dur=1.250, lixray-web-resolve;dur=2.500, lixray-server-roundtrip;dur=8.750, lix-server-protocol;dur=1.500",
		),
		{
			"lixray-web-auth": 1.25,
			"lixray-web-resolve": 2.5,
			"lixray-server-roundtrip": 8.75,
			"lix-server-protocol": 1.5,
		},
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
