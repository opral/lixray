import assert from "node:assert/strict";
import test from "node:test";
import { provisionAccountAfterHandshake } from "./lix-account-provisioning.ts";

const account = {
	id: "01920000-0000-7000-8000-000000000601",
	kind: "human",
	name: "Example Account",
	profileUri: "https://lixray.com/profile/11111111-1111-4111-8111-111111111111",
};

void test("accounts without a public profile can open repositories", async () => {
	const handshake = Response.json({
		activeAccountId: account.id,
		sessionId: "session-1",
	});
	assert.equal(
		await provisionAccountAfterHandshake({
			protocolPath: "/lix/v1/",
			response: handshake,
			account: { ...account, profileUri: null },
			lixFetch: () => {
				throw new Error("There is no profile to provision");
			},
		}),
		handshake,
	);
});

void test("successful authenticated handshake enriches the repository account", async () => {
	let request: Request | undefined;
	const handshake = Response.json({
		activeAccountId: account.id,
		sessionId: "session-1",
	});
	const response = await provisionAccountAfterHandshake({
		protocolPath: "/lix/v1/",
		response: handshake,
		account,
		lixFetch: async (candidate) => {
			request = candidate;
			return Response.json({ rowsAffected: 1 });
		},
	});

	assert.equal(response, handshake);
	assert.ok(request);
	assert.equal(new URL(request.url).pathname, "/lix/v1/execute");
	assert.equal(request.headers.get("lix-session-id"), "session-1");
	assert.equal(
		request.headers.get("x-lixray-idempotency-principal"),
		account.id,
	);
	const body: unknown = await request.json();
	assert.ok(body && typeof body === "object");
	const record = body as Record<string, unknown>;
	if (typeof record.sql !== "string") {
		assert.fail("provisioning SQL must be a string");
	}
	assert.ok(Array.isArray(record.params));
	assert.match(record.sql, /UPDATE lix_account/);
	assert.deepEqual(
		(record.params as Array<{ value: string }>).map(
			(parameter) => parameter.value,
		),
		[account.id, account.name, account.kind, account.profileUri],
	);
});

void test("non-handshake responses do not provision an account", async () => {
	let calls = 0;
	const response = new Response("ok");
	assert.equal(
		await provisionAccountAfterHandshake({
			protocolPath: "/lix/v1/execute",
			response,
			account,
			lixFetch: async () => {
				calls += 1;
				return new Response();
			},
		}),
		response,
	);
	assert.equal(calls, 0);
});

void test("handshake fails closed when account enrichment fails", async () => {
	const response = await provisionAccountAfterHandshake({
		protocolPath: "/lix/v1/",
		response: Response.json({
			activeAccountId: account.id,
			sessionId: "session-1",
		}),
		account,
		lixFetch: async () => new Response("bad", { status: 500 }),
	});
	assert.equal(response.status, 502);
});
