import assert from "node:assert/strict";
import test from "node:test";
import { createHostedRepository } from "./repository-create.ts";
const id = "11111111-1111-4111-8111-111111111111";
const account = {
	userId: "22222222-2222-4222-8222-222222222222",
	token: "user",
};
const env = {
	SUPABASE_URL: "https://database.test",
	SUPABASE_PUBLISHABLE_KEY: "public",
	SUPABASE_SERVICE_ROLE_KEY: "secret",
	LIXRAY_LIX_SERVICE_URL: "http://server.test",
	LIXRAY_INTERNAL_TOKEN: "internal",
};
function request() {
	return new Request("https://lixray.test/lix/v1", {
		method: "POST",
		headers: {
			"content-type": "application/vnd.lix.snapshot",
			"idempotency-key": "stable-key",
			"x-lix-account-id": "attacker",
			"x-lix-idempotency-scope": "attacker",
		},
		body: "snapshot",
	});
}

void test("streams creation under authenticated principal and registers before returning a public locator", async () => {
	const calls: Request[] = [];
	const response = await createHostedRepository(
		request(),
		env,
		account,
		async (input, init) => {
			const req = new Request(input, init);
			calls.push(req);
			if (calls.length === 1)
				return Response.json([{ primary_namespace_id: "personal" }]);
			if (calls.length === 2) {
				assert.equal(await req.text(), "snapshot");
				return Response.json(
					{ id, url: `http://internal/lix/${id}` },
					{ status: 201 },
				);
			}
			assert.deepEqual(await req.json(), {
				p_lix_id: id,
				p_account_id: account.userId,
			});
			return new Response(null, { status: 204 });
		},
	);
	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), {
		id,
		url: `https://lixray.test/lix/${id}`,
	});
	assert.equal(calls[1]!.headers.get("x-lix-account-id"), account.userId);
	assert.equal(
		calls[1]!.headers.get("x-lix-idempotency-scope"),
		account.userId,
	);
	assert.equal(calls[1]!.headers.get("authorization"), "Bearer internal");
	assert.equal(calls[2]!.headers.get("authorization"), "Bearer secret");
});

void test("retry after registration failure reuses the original scoped creation key", async () => {
	const keys: string[] = [];
	let registrations = 0;
	const fetcher: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		if (req.url.includes("/rest/v1/accounts"))
			return Response.json([{ primary_namespace_id: "personal" }]);
		if (req.url.endsWith("register_hosted_lix"))
			return new Response(null, { status: ++registrations === 1 ? 503 : 204 });
		keys.push(req.headers.get("idempotency-key")!);
		await req.text();
		return Response.json({ id }, { status: 201 });
	};
	assert.equal(
		(await createHostedRepository(request(), env, account, fetcher)).status,
		503,
	);
	assert.equal(
		(await createHostedRepository(request(), env, account, fetcher)).status,
		201,
	);
	assert.deepEqual(keys, ["stable-key", "stable-key"]);
});

for (const upstream of [
	new Response("invalid snapshot", { status: 400 }),
	Response.json({ id: "invalid" }, { status: 201 }),
	new Response("x".repeat(65537), { status: 201 }),
]) {
	void test(`does not register failed or invalid creation (${upstream.status})`, async () => {
		let calls = 0;
		const response = await createHostedRepository(
			request(),
			env,
			account,
			async () =>
				++calls === 1
					? Response.json([{ primary_namespace_id: "personal" }])
					: upstream,
		);
		assert.ok(response.status >= 400);
		assert.equal(calls, 2);
	});
}
void test("missing configuration stops before consuming the upload", async () => {
	let calls = 0;
	assert.equal(
		(
			await createHostedRepository(request(), {}, account, async () => {
				calls++;
				return Response.json({});
			})
		).status,
		503,
	);
	assert.equal(calls, 0);
});

void test("public collection route requires authentication before any upstream work", async () => {
	const { handleRequest } = await import("./handler.ts");
	let calls = 0;
	const response = await handleRequest(request(), env, {
		authenticate: async () => ({
			ok: false,
			response: new Response("Sign in", { status: 401 }),
		}),
		fetch: async () => {
			calls++;
			throw new Error("must not contact upstream");
		},
	});
	assert.equal(response.status, 401);
	assert.equal(calls, 0);
});

void test("public collection route dispatches creation and preserves CORS", async () => {
	const { handleRequest } = await import("./handler.ts");
	let calls = 0;
	const req = request();
	req.headers.set("origin", "https://client.test");
	const response = await handleRequest(req, env, {
		authenticate: async () => ({ ok: true, auth: account }),
		fetch: async (input, init) => {
			const req = new Request(input, init);
			calls++;
			if (req.url.endsWith("/lix/v1")) {
				await req.text();
				return Response.json({ id }, { status: 201 });
			}
			return Response.json([{ primary_namespace_id: "personal" }]);
		},
	});
	assert.equal(response.status, 201);
	assert.equal(calls, 3);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"https://client.test",
	);
});

void test("repository OAuth authentication preserves the issuer, audience and resource boundary", async () => {
	const { validateRepositoryJwtClaims } = await import("./handler.ts");
	const issuer = "https://auth.test/auth/v1";
	const claims = {
		sub: account.userId,
		iss: issuer,
		aud: "authenticated",
		role: "authenticated",
		exp: Math.floor(Date.now() / 1000) + 300,
		client_id: "flashtype",
		lixray_mcp: true,
		resource: "https://lixray.com",
		scope: "openid",
	};
	assert.equal(
		validateRepositoryJwtClaims(claims, issuer, "https://lixray.com"),
		true,
	);
	for (const invalid of [
		{ resource: "https://other.test" },
		{ iss: "https://other.test" },
		{ aud: "other" },
		{ scope: "" },
		{ lixray_mcp: false },
		{ exp: 0 },
	])
		assert.equal(
			validateRepositoryJwtClaims(
				{ ...claims, ...invalid },
				issuer,
				"https://lixray.com",
			),
			false,
		);
});
