import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionLix } from "./check-production-lix.mjs";

void test("checks a handshake and read, then closes the canary session", async () => {
	const requests = [];
	const result = await checkProductionLix({
		repositoryUrl: "https://lixray.example/@lixray/canary",
		fetchImpl: async (url, init = {}) => {
			requests.push({
				method: init.method ?? "GET",
				pathname: new URL(url).pathname,
				sessionId: init.headers?.["Lix-Session-Id"],
			});
			if (new URL(url).pathname.endsWith("/lix/v1/")) {
				return Response.json({ protocolVersion: 2, sessionId: "session-1" });
			}
			if (new URL(url).pathname.endsWith("/lix/v1/execute")) {
				return Response.json({ rows: [[{ kind: "int", value: 1 }]] });
			}
			return new Response(null, { status: 204 });
		},
	});

	assert.deepEqual(result, {
		protocolVersion: 2,
		repository: "/@lixray/canary",
	});
	assert.deepEqual(requests, [
		{
			method: "GET",
			pathname: "/@lixray/canary/lix/v1/",
			sessionId: undefined,
		},
		{
			method: "POST",
			pathname: "/@lixray/canary/lix/v1/execute",
			sessionId: "session-1",
		},
		{
			method: "DELETE",
			pathname: "/@lixray/canary/lix/v1/session",
			sessionId: "session-1",
		},
	]);
});

void test("reports recovering repositories and does not attempt a close", async () => {
	let requests = 0;
	await assert.rejects(
		checkProductionLix({
			repositoryUrl: "https://lixray.example/@lixray/canary",
			fetchImpl: async () => {
				requests += 1;
				return Response.json(
					{ error: { code: "LIX_ERROR_LIX_RECOVERING" } },
					{ status: 503 },
				);
			},
		}),
		/HTTP 503 LIX_ERROR_LIX_RECOVERING/,
	);
	assert.equal(requests, 1);
});

void test("fails when the canary session cannot close", async () => {
	await assert.rejects(
		checkProductionLix({
			repositoryUrl: "https://lixray.example/@lixray/canary",
			fetchImpl: async (url, init = {}) => {
				const pathname = new URL(url).pathname;
				if (pathname.endsWith("/lix/v1/")) {
					return Response.json({ protocolVersion: 2, sessionId: "session-1" });
				}
				if (init.method === "DELETE") {
					return Response.json(
						{ error: { code: "LIX_ERROR_INTERNAL" } },
						{ status: 500 },
					);
				}
				return Response.json({ rows: [[{ kind: "int", value: 1 }]] });
			},
		}),
		/close failed with HTTP 500 LIX_ERROR_INTERNAL/,
	);
});
