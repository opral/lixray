import assert from "node:assert/strict";
import test from "node:test";
import { deleteHostedRepository } from "./repository-delete.ts";
import { handleRequest } from "./handler.ts";
const id = "11111111-1111-4111-8111-111111111111";
const account = {
	userId: "22222222-2222-4222-8222-222222222222",
	token: "user",
};
const env = {
	SUPABASE_URL: "https://database.test",
	SUPABASE_SERVICE_ROLE_KEY: "secret",
	LIXRAY_LIX_SERVICE_URL: "https://storage.test",
	LIXRAY_INTERNAL_TOKEN: "internal",
};
const request = () =>
	new Request(`https://lixray.test/lix/v1/${id}`, {
		method: "DELETE",
		headers: { "x-lix-account-id": "attacker" },
	});

void test("admin deletion uses protocol storage then records metadata", async () => {
	const calls: string[] = [];
	const response = await deleteHostedRepository(
		request(),
		id,
		env,
		account,
		async (input, init) => {
			const req = new Request(input, init);
			calls.push(new URL(req.url).pathname);
			if (calls.length === 1) return Response.json(false);
			if (calls.length === 2) {
				assert.equal(req.method, "DELETE");
				assert.equal(req.headers.get("x-lix-account-id"), account.userId);
				assert.equal(req.headers.get("authorization"), "Bearer internal");
			} else
				assert.deepEqual(await req.json(), {
					p_lix_id: id,
					p_account_id: account.userId,
				});
			return new Response(null, { status: 204 });
		},
	);
	assert.equal(response.status, 204);
	assert.deepEqual(calls, [
		"/rest/v1/rpc/authorize_hosted_lix_deletion",
		`/lix/v1/${id}`,
		"/rest/v1/rpc/delete_hosted_lix",
	]);
});
void test("membership alone cannot delete storage", async () => {
	let calls = 0;
	const response = await handleRequest(request(), env, {
		authenticate: async () => ({ ok: true, auth: account }),
		fetch: async () => {
			calls++;
			return new Response(null, { status: 403 });
		},
	});
	assert.equal(response.status, 403);
	assert.equal(calls, 1);
});
void test("repeating a completed delete returns 204 without touching storage", async () => {
	let calls = 0;
	const response = await deleteHostedRepository(
		request(),
		id,
		env,
		account,
		async () => {
			calls++;
			return Response.json(true);
		},
	);
	assert.equal(response.status, 204);
	assert.equal(calls, 1);
});
void test("retry finishes metadata after storage was already deleted", async () => {
	let storageCalls = 0;
	let finalizations = 0;
	const fetcher: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		if (req.url.endsWith("authorize_hosted_lix_deletion"))
			return Response.json(false);
		if (req.url.endsWith("delete_hosted_lix"))
			return new Response(null, { status: ++finalizations === 1 ? 503 : 204 });
		return new Response(null, { status: ++storageCalls === 1 ? 204 : 404 });
	};
	assert.equal(
		(await deleteHostedRepository(request(), id, env, account, fetcher)).status,
		503,
	);
	assert.equal(
		(await deleteHostedRepository(request(), id, env, account, fetcher)).status,
		204,
	);
	assert.equal(finalizations, 2);
});
void test("failed storage deletion never marks metadata deleted", async () => {
	let calls = 0;
	const response = await deleteHostedRepository(
		request(),
		id,
		env,
		account,
		async () =>
			++calls === 1
				? Response.json(false)
				: new Response(null, { status: 503 }),
	);
	assert.equal(response.status, 503);
	assert.equal(calls, 2);
});
void test("anonymous deletion never reaches storage", async () => {
	const response = await handleRequest(request(), env, {
		authenticate: async () => ({
			ok: false,
			response: new Response(null, { status: 401 }),
		}),
		fetch: async () => {
			throw new Error("must not fetch");
		},
	});
	assert.equal(response.status, 401);
});

void test("opening a missing repository never creates storage", async () => {
	const requests: Request[] = [];
	const response = await handleRequest(
		new Request(`https://lixray.test/lix/v1/${id}`, {
			headers: { authorization: "Bearer user" },
		}),
		env,
		{
			authenticate: async () => ({ ok: true, auth: account }),
			authorizeLix: async () => null,
			lixFetch: async (_id, request) => {
				requests.push(request);
				return new Response(null, { status: 404 });
			},
			fetch: async () => {
				throw new Error("must not register or provision");
			},
		},
	);
	assert.equal(response.status, 404);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.method, "GET");
});
void test("removed provisioning endpoint does not reach storage", async () => {
	const response = await handleRequest(
		new Request(`https://lixray.test/api/repositories/${id}/provision`, {
			method: "POST",
		}),
		env,
		{
			fallback: async () => new Response(null, { status: 404 }),
			fetch: async () => {
				throw new Error("must not fetch");
			},
			lixFetch: async () => {
				throw new Error("must not initialize");
			},
		},
	);
	assert.equal(response.status, 404);
});
