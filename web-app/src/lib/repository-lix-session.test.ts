import assert from "node:assert/strict";
import test from "node:test";
import {
	openRepositoryLixSession,
	parseLixrayServerTiming,
} from "./repository-lix-session.ts";

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

void test("retries a recovering repository until its handshake succeeds", async (t) => {
	let handshakeAttempts = 0;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? input
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith("/lix/v1/")) {
			handshakeAttempts += 1;
			if (handshakeAttempts < 3) {
				return Response.json(
					{
						error: {
							code: "LIX_ERROR_LIX_RECOVERING",
							message: "The lix is recovering.",
						},
					},
					{ status: 503 },
				);
			}
			return Response.json({
				protocolVersion: 2,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId: "recovered-session",
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		return new Response("Not found", { status: 404 });
	};

	const session = await openRepositoryLixSession({
		namespace: "acme",
		repositorySlug: "launch-q3",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		fetch,
	});
	t.after(() => session.close());

	assert.equal(handshakeAttempts, 3);
	assert.equal(session.activeBranchSnapshot(), "main");
});

void test("refreshes an expired access token and retries the remote request once", async (t) => {
	let accessToken = "expired-token";
	let refreshCalls = 0;
	let executeAttempts = 0;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith("/lix/v1/")) {
			return Response.json({
				protocolVersion: 2,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId: "fresh-session",
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		if (
			pathname.endsWith("/lix/v1/execute") ||
			pathname.endsWith("/lix/v1/execute-batch")
		) {
			executeAttempts += 1;
			if (executeAttempts === 1) {
				assert.equal(
					request.headers.get("authorization"),
					"Bearer expired-token",
				);
				return new Response("Unauthorized\n", { status: 401 });
			}
			assert.equal(request.headers.get("authorization"), "Bearer fresh-token");
			const result = {
				columns: ["value"],
				rows: [[{ kind: "int", value: 1 }]],
				rowsAffected: 0,
				notices: [],
			};
			return pathname.endsWith("/execute-batch")
				? Response.json([result])
				: Response.json(result);
		}
		throw new Error(`Unexpected remote request: ${request.method} ${pathname}`);
	};

	const session = await openRepositoryLixSession({
		namespace: "acme-refresh",
		repositorySlug: "launch-q3-refresh",
		origin: "https://lixray.test",
		getAccessToken: async () => accessToken,
		refreshAccessToken: async () => {
			refreshCalls += 1;
			accessToken = "fresh-token";
			return accessToken;
		},
		fetch,
	});
	t.after(() => session.close());

	const result = await session.lix.execute("SELECT 1");
	assert.equal(result.rows[0]?.toObject().value, 1);
	assert.equal(refreshCalls, 1);
	assert.equal(executeAttempts, 2);
});

void test("notifies the host when a live protocol session is gone so it can remount", async (t) => {
	let goneCalls = 0;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith("/lix/v1/")) {
			return Response.json({
				protocolVersion: 2,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId: "stale-session",
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 410 });
		}
		if (pathname.endsWith("/lix/v1/execute")) {
			return Response.json(
				{
					error: {
						code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
						message:
							"the Lix protocol session is unknown, expired, or closed; open a new client session",
					},
				},
				{ status: 410 },
			);
		}
		throw new Error(`Unexpected remote request: ${request.method} ${pathname}`);
	};

	const session = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "monorepo",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		fetch,
		onProtocolSessionGone: () => {
			goneCalls += 1;
		},
	});
	t.after(() => session.close());

	await assert.rejects(() => session.lix.execute("SELECT 1"), {
		status: 410,
		code: "LIX_ERROR_PROTOCOL_SESSION_GONE",
	});
	assert.equal(goneCalls, 1);
});

void test("does not treat a gone-session DELETE as a remount signal", async () => {
	let goneCalls = 0;
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		if (pathname.endsWith("/lix/v1/")) {
			return Response.json({
				protocolVersion: 2,
				activeBranchId: "main",
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId: "closing-session",
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 410 });
		}
		throw new Error(`Unexpected remote request: ${request.method} ${pathname}`);
	};

	const session = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "closing",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		fetch,
		onProtocolSessionGone: () => {
			goneCalls += 1;
		},
	});
	await session.close();
	assert.equal(goneCalls, 0);
});

void test("opens a new managed client session after the host bumps the epoch", async (t) => {
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

	const first = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "epoch",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		fetch,
	});
	const second = await openRepositoryLixSession({
		namespace: "opral",
		repositorySlug: "epoch",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		fetch,
		sessionEpoch: 1,
	});
	t.after(async () => {
		await first.close();
		await second.close();
	});

	assert.deepEqual(sessionIds, ["session-1", "session-2"]);
	assert.notEqual(first.lix, second.lix);
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
