import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionLix } from "./check-production-lix.mjs";

void test("checks a handshake and read, then closes the canary session", async () => {
	const requests = [];
	const result = await checkProductionLix({
		lixUrl: "https://lixray.example/lix/11111111-1111-4111-8111-111111111111",
		fetchImpl: async (url, init = {}) => {
			assert.equal(new Headers(init.headers).get("lix-server-protocol-version"), "9");
			requests.push({
				method: init.method ?? "GET",
				pathname: new URL(url).pathname,
				sessionId: init.headers?.["Lix-Session-Id"],
			});
			if (new URL(url).pathname.endsWith("/lix/v1/11111111-1111-4111-8111-111111111111/")) {
				return Response.json({ protocolVersion: 9, sessionId: "session-1" });
			}
			if (new URL(url).pathname.endsWith("/lix/v1/11111111-1111-4111-8111-111111111111/execute")) {
				return Response.json({ rows: [[{ kind: "int", value: 1 }]] });
			}
			return new Response(null, { status: 204 });
		},
	});

	assert.deepEqual(result, {
		protocolVersion: 9,
		lix: "/lix/11111111-1111-4111-8111-111111111111",
	});
	assert.deepEqual(requests, [
		{
			method: "GET",
			pathname: "/lix/v1/11111111-1111-4111-8111-111111111111/",
			sessionId: undefined,
		},
		{
			method: "POST",
			pathname: "/lix/v1/11111111-1111-4111-8111-111111111111/execute",
			sessionId: "session-1",
		},
		{
			method: "DELETE",
			pathname: "/lix/v1/11111111-1111-4111-8111-111111111111/session",
			sessionId: "session-1",
		},
	]);
});

void test("migration-required repositories fail immediately instead of polling ordinary opening", async () => {
 let calls = 0;
 await assert.rejects(checkProductionLix({lixUrl:"https://lixray.example/lix/11111111-1111-4111-8111-111111111111", fetchImpl: async () => {
  calls += 1;
  return Response.json({error:{code:"LIX_MIGRATION_REQUIRED"}}, {status:503});
 }}), /HTTP 503 LIX_MIGRATION_REQUIRED/);
 assert.equal(calls,1);
});

void test("reports recovering repositories and does not attempt a close", async () => {
	let requests = 0;
	await assert.rejects(
		checkProductionLix({
			lixUrl: "https://lixray.example/lix/11111111-1111-4111-8111-111111111111",
			fetchImpl: async () => {
				requests += 1;
				return Response.json(
					{ error: { code: "LIX_ERROR_RECOVERING" } },
					{ status: 503 },
				);
			},
		}),
		/HTTP 503 LIX_ERROR_RECOVERING/,
	);
	assert.equal(requests, 1);
});

void test("fails when the canary session cannot close", async () => {
	await assert.rejects(
		checkProductionLix({
			lixUrl: "https://lixray.example/lix/11111111-1111-4111-8111-111111111111",
			fetchImpl: async (url, init = {}) => {
				const pathname = new URL(url).pathname;
				if (pathname.endsWith("/lix/v1/11111111-1111-4111-8111-111111111111/")) {
					return Response.json({ protocolVersion: 9, sessionId: "session-1" });
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

void test("rejects non-root and plaintext production connection URLs", async () => {
	for (const lixUrl of [
		"https://lixray.example/prefix/lix/11111111-1111-4111-8111-111111111111",
		"http://lixray.example/lix/11111111-1111-4111-8111-111111111111",
		"https://lixray.example/lix/11111111-1111-4111-8111-111111111111/",
	]) {
		await assert.rejects(
			checkProductionLix({ lixUrl, fetchImpl: async () => new Response() }),
		);
	}
});
