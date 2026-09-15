import { compatibility } from "@lix-js/sdk/compatibility";
import assert from "node:assert/strict";
import test from "node:test";
import { provisionAccountAfterHandshake } from "./lix-account-provisioning.ts";

const lixId = "11111111-1111-4111-8111-111111111111";

const account = {
	id: "01920000-0000-7000-8000-000000000601",
	kind: "human",
	name: "Example Account",
	profileUri: "https://lixray.com/profile/11111111-1111-4111-8111-111111111111",
};

function profileResponse(profile: Array<string | null>) {
	return Response.json({
		rows: [
			profile.map((value) => ({
				kind: value === null ? "null" : "text",
				value,
			})),
		],
	});
}

void test("accounts without a public profile can open repositories", async () => {
	const handshake = Response.json({
		activeAccountId: account.id,
		sessionId: "session-1",
	});
	assert.equal(
		await provisionAccountAfterHandshake({
			lixId,
			protocolPath: `/lix/v1/${lixId}/`,
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
		lixId,
		protocolPath: `/lix/v1/${lixId}/`,
		response: handshake,
		account,
		lixFetch: async (candidate) => {
			const { sql } = (await candidate.clone().json()) as { sql: string };
			if (sql.startsWith("SELECT"))
				return profileResponse([account.id, account.kind, null]);
			request = candidate;
			return Response.json({ rowsAffected: 1 });
		},
	});

	assert.equal(response, handshake);
	assert.ok(request);
	assert.equal(new URL(request.url).pathname, `/lix/v1/${lixId}/execute`);
	assert.equal(request.headers.get("lix-session-id"), "session-1");
	assert.equal(
		request.headers.get("lix-server-protocol-version"),
		String(compatibility.serverProtocolVersion),
	);
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
			lixId,
			protocolPath: `/lix/v1/${lixId}/execute`,
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
		lixId,
		protocolPath: `/lix/v1/${lixId}/`,
		response: Response.json({
			activeAccountId: account.id,
			sessionId: "session-1",
		}),
		account,
		lixFetch: async (request) => {
			const { sql } = (await request.json()) as { sql: string };
			return sql.startsWith("SELECT")
				? profileResponse([account.id, account.kind, null])
				: new Response("bad", { status: 500 });
		},
	});
	assert.equal(response.status, 502);
});

void test("unchanged profiles do not append account changes on reopen", async () => {
	let calls = 0;
	const handshake = Response.json({
		activeAccountId: account.id,
		sessionId: "session-1",
	});
	const response = await provisionAccountAfterHandshake({
		lixId,
		protocolPath: `/lix/v1/${lixId}/`,
		response: handshake,
		account,
		lixFetch: async (request) => {
			calls += 1;
			const { sql } = (await request.json()) as { sql: string };
			assert.match(sql, /^SELECT/);
			return profileResponse([account.name, account.kind, account.profileUri]);
		},
	});
	assert.equal(response, handshake);
	assert.equal(calls, 1);
});

for (const invalidProfile of [
	null,
	{},
	{ rows: [] },
	{ rows: [[{ kind: "text", value: account.name }]] },
]) {
	void test(`handshake fails closed for missing or malformed account profile ${JSON.stringify(invalidProfile)}`, async () => {
		const response = await provisionAccountAfterHandshake({
			lixId,
			protocolPath: `/lix/v1/${lixId}/`,
			response: Response.json({
				activeAccountId: account.id,
				sessionId: "session-1",
			}),
			account,
			lixFetch: async () => Response.json(invalidProfile),
		});
		assert.equal(response.status, 502);
	});
}

void test("mismatched handshake account never reads or updates a profile", async () => {
	const response = await provisionAccountAfterHandshake({
		lixId,
		protocolPath: `/lix/v1/${lixId}/`,
		response: Response.json({
			activeAccountId: "another-account",
			sessionId: "session-1",
		}),
		account,
		lixFetch: () => {
			throw new Error("must not provision mismatched identity");
		},
	});
	assert.equal(response.status, 502);
});

for (const failure of [
	{
		name: "upstream profile read fails",
		response: () => new Response("unavailable", { status: 503 }),
	},
	{
		name: "upstream profile read is invalid JSON",
		response: () => new Response("invalid JSON"),
	},
]) {
	void test(failure.name, async () => {
		let calls = 0;
		const response = await provisionAccountAfterHandshake({
			lixId,
			protocolPath: `/lix/v1/${lixId}/`,
			response: Response.json({
				activeAccountId: account.id,
				sessionId: "session-1",
			}),
			account,
			lixFetch: async () => {
				calls += 1;
				return failure.response();
			},
		});
		assert.equal(response.status, 502);
		assert.equal(
			calls,
			1,
			"failed read must not be followed by an account write",
		);
	});
}
