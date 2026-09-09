import assert from "node:assert/strict";
import test from "node:test";
import { provisionLixService } from "./repository-provisioning.ts";
import { handleRequest } from "./handler.ts";
const id = "11111111-1111-4111-8111-111111111111";
const account = "22222222-2222-4222-8222-222222222222";
const env = {
	SUPABASE_URL: "https://database.test",
	SUPABASE_PUBLISHABLE_KEY: "public",
	LIXRAY_LIX_SERVICE_URL: "http://server.test",
	LIXRAY_INTERNAL_TOKEN: "internal",
};
for (const mode of ["create-new", "adopt-existing"]) {
	void test(`explicit provision preserves ${mode} and canonical identity`, async () => {
		const calls: Request[] = [];
		const response = await provisionLixService(
			env,
			id,
			"user-token",
			account,
			async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				return calls.length === 1
					? Response.json([{ storage_provision_mode: mode }])
					: Response.json({ id });
			},
		);
		assert.equal(response.status, 200);
		assert.equal(calls[0]!.headers.get("authorization"), "Bearer user-token");
		assert.equal(
			calls[1]!.url,
			`http://server.test/internal/repositories/${id}/provision`,
		);
		assert.equal(calls[1]!.headers.get("authorization"), "Bearer internal");
		assert.equal(calls[1]!.headers.get("x-lix-account-id"), account);
		assert.deepEqual(await calls[1]!.json(), { mode });
	});
}
void test("missing control metadata never creates an empty repository", async () => {
	let calls = 0;
	const response = await provisionLixService(
		env,
		id,
		"token",
		account,
		async () => {
			calls++;
			return Response.json([]);
		},
	);
	assert.equal(response.status, 409);
	assert.equal(calls, 1);
});
void test("adoption rejection is returned without retrying creation", async () => {
	let calls = 0;
	const response = await provisionLixService(
		env,
		id,
		"token",
		account,
		async () => {
			calls++;
			return calls === 1
				? Response.json([{ storage_provision_mode: "adopt-existing" }])
				: new Response("missing durable storage", { status: 409 });
		},
	);
	assert.equal(response.status, 409);
	assert.equal(calls, 2);
});
for (const authorized of [false, true]) {
	void test(`provision action checks repository authorization (${authorized})`, async () => {
		let calls = 0;
		const response = await handleRequest(
			new Request(`https://gateway.test/api/repositories/${id}/provision`, {
				method: "POST",
			}),
			env,
			{
				authenticate: async () => ({
					ok: true,
					auth: { userId: account, token: "user-token" },
				}),
				authorizeLix: async () =>
					authorized ? null : new Response("denied", { status: 403 }),
				provisionLix: async (repository, token, principal) => {
					calls++;
					assert.equal(repository, id);
					assert.equal(token, "user-token");
					assert.equal(principal, account);
					return Response.json({ id });
				},
			},
		);
		assert.equal(response.status, authorized ? 200 : 403);
		assert.equal(calls, authorized ? 1 : 0);
	});
}
void test("unauthenticated provisioning never reaches storage", async () => {
	const response = await handleRequest(
		new Request(`https://gateway.test/api/repositories/${id}/provision`, {
			method: "POST",
		}),
		env,
		{
			authenticate: async () => ({
				ok: false,
				response: new Response("unauthorized", { status: 401 }),
			}),
			provisionLix: async () => {
				throw new Error("must not provision");
			},
		},
	);
	assert.equal(response.status, 401);
});

void test("PAT provisioning uses scoped authorization RPC instead of a Supabase bearer", async () => {
	const token = `lixray_pat_${"a".repeat(64)}`;
	let calls = 0;
	const response = await provisionLixService(
		env,
		id,
		token,
		account,
		async (input, init) => {
			const request = new Request(input, init);
			calls++;
			if (calls === 1) {
				assert.equal(request.headers.get("authorization"), null);
				assert.deepEqual(await request.json(), {
					p_lix_id: id,
					p_api_token: token,
				});
				return Response.json([{ storage_provision_mode: "create-new" }]);
			}
			return Response.json({ id });
		},
	);
	assert.equal(response.status, 200);
	assert.equal(calls, 2);
});

void test("remote provisioning is lazy, shared across concurrent requests, and retried after a transport failure", async () => {
	const { createProvisioningFetch } =
		await import("../lib/provision-repository.ts");
	let provisions = 0;
	let protocol = 0;
	let fail = true;
	const wrapped = createProvisioningFetch({
		repositoryId: id,
		getAccessToken: async () => "token",
		fetch: async (input) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("/provision")) {
				provisions++;
				if (fail) throw new TypeError("offline");
				return Response.json({ id });
			}
			protocol++;
			return Response.json({ ok: true });
		},
	});
	// Constructing the SDK transport does not require the network for a local open.
	assert.equal(provisions, 0);
	await assert.rejects(
		wrapped(`https://gateway.test/lix/v1/${id}/`),
		/offline/,
	);
	assert.equal(protocol, 0);
	fail = false;
	await Promise.all([
		wrapped(`https://gateway.test/lix/v1/${id}/`),
		wrapped(`https://gateway.test/lix/v1/${id}/snapshot`),
	]);
	assert.equal(provisions, 2);
	assert.equal(protocol, 2);
});
