import assert from "node:assert/strict";
import test from "node:test";
import {
	createTelemetryFetch,
	parseLixrayServerTiming,
	repositorySessionKey,
} from "./repository-lix-session.ts";

void test("isolates managed OPFS sessions by replica identity", () => {
	const repository = {
		namespace: "acme",
		repositorySlug: "launch-q3",
		origin: "https://lixray.test",
		getAccessToken: async () => null,
	};

	assert.notEqual(
		repositorySessionKey({ ...repository, replicaId: "anonymous" }),
		repositorySessionKey({ ...repository, replicaId: "account-123" }),
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

void test("opens a new client session when the signed-in identity changes", async (t) => {
	const sessionIds: string[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith("/lix/v1/")) {
			const sessionId = `session-${sessionIds.length + 1}`;
			sessionIds.push(sessionId);
			return Response.json({
				protocolVersion: 2,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId,
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected remote request: ${request.method} ${pathname}`);
	};

	const anonymous = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "monorepo",
		origin: "https://lixray.test",
		getAccessToken: async () => null,
		allowAnonymous: true,
		authIdentity: "public:acc2bc33",
		fetch,
	});
	const signedIn = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "monorepo",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		authIdentity: "user-samuel",
		fetch,
	});
	t.after(async () => {
		await anonymous.close();
		await signedIn.close();
	});

	assert.deepEqual(sessionIds, ["session-1", "session-2"]);
	assert.notEqual(anonymous.lix, signedIn.lix);
});
