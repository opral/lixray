import assert from "node:assert/strict";
import test from "node:test";
import { openRepositoryLixSession } from "./repository-lix-session.ts";

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
