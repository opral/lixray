import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiToken } from "./api-token.ts";
import { handleRequest } from "./handler.ts";

const token = `lixray_pat_${"a".repeat(64)}`;
const lixId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const env = {
	SUPABASE_URL: "https://db.example",
	SUPABASE_PUBLISHABLE_KEY: "public-key",
};
const authorizedRow = {
	account_id: accountId,
	kind: "human",
	name: "Example",
	profile_uri: null,
	allowed: true,
};

void test("API token lookup sends the raw credential in a POST body and resolves the account", async () => {
	const result = await authorizeApiToken(
		token,
		lixId,
		env,
		async (input, init) => {
			assert.ok(input instanceof URL);
			assert.equal(
				input.href,
				"https://db.example/rest/v1/rpc/authorize_api_token",
			);
			assert.equal(init?.method, "POST");
			assert.equal(init?.cache, "no-store");
			assert.equal(typeof init?.body, "string");
			assert.deepEqual(JSON.parse(init?.body as string), {
				p_token: token,
				p_lix_id: lixId,
			});
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			assert.equal(new Headers(init?.headers).get("apikey"), "public-key");
			return Response.json([authorizedRow]);
		},
	);
	assert.deepEqual(result, {
		ok: true,
		account: {
			id: accountId,
			kind: "human",
			name: "Example",
			profileUri: null,
		},
	});
});

for (const [label, rows, status] of [
	["expired, revoked or unknown", [], 401],
	["missing membership", [{ ...authorizedRow, allowed: false }], 403],
	["malformed account", [{ ...authorizedRow, account_id: "spoofed" }], 503],
	["invalid response", {}, 503],
] as const) {
	void test(`API token fails closed for ${label}`, async () => {
		const result = await authorizeApiToken(token, lixId, env, async () =>
			Response.json(rows),
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.response.status, status);
		assert.equal(result.response.headers.get("cache-control"), "no-store");
		assert.ok(!(await result.response.text()).includes(token));
	});
}

void test("malformed API tokens never reach the database", async () => {
	const result = await authorizeApiToken(
		"lixray_pat_invalid",
		lixId,
		env,
		() => {
			throw new Error("must not fetch");
		},
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.response.status, 401);
});

void test("database outages fail closed without exposing upstream content", async () => {
	for (const fetchImpl of [
		async () => new Response(token, { status: 500 }),
		async () => {
			throw new Error(token);
		},
	]) {
		const result = await authorizeApiToken(token, lixId, env, fetchImpl);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.response.status, 503);
			assert.ok(!(await result.response.text()).includes(token));
		}
	}
});

void test("SDK requests use the canonical token principal and recheck revocation on every request", async () => {
	let valid = true;
	let lookups = 0;
	let upstreamRequests = 0;
	const options = {
		fetch: async () => {
			lookups++;
			return Response.json(valid ? [authorizedRow] : []);
		},
		lixFetch: async (_id: string, request: Request) => {
			upstreamRequests++;
			assert.equal(
				request.headers.get("x-lixray-idempotency-principal"),
				accountId,
			);
			return Response.json({ rows: [] });
		},
	};
	const request = () =>
		new Request(`https://lixray.example/lix/v1/${lixId}/execute`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"x-lixray-idempotency-principal": "spoofed",
			},
			body: JSON.stringify({ sql: "SELECT 1" }),
		});
	assert.equal((await handleRequest(request(), env, options)).status, 200);
	valid = false;
	assert.equal((await handleRequest(request(), env, options)).status, 401);
	assert.equal(lookups, 2);
	assert.equal(upstreamRequests, 1);
});

void test("a token cannot fall back to public repository access when denied", async () => {
	const response = await handleRequest(
		new Request(
			`https://lixray.example/lix/v1/${lixId}/file?path=/public.txt`,
			{ headers: { Authorization: `Bearer ${token}` } },
		),
		env,
		{
			fetch: async () => Response.json([{ ...authorizedRow, allowed: false }]),
			lixFetch: async () => {
				throw new Error("must not proxy");
			},
		},
	);
	assert.equal(response.status, 403);
});
