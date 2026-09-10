import assert from "node:assert/strict";
import test from "node:test";
import { createHostedRepository } from "./repository-create.ts";
const id = "11111111-1111-4111-8111-111111111111";
const namespaceId = "33333333-3333-4333-8333-333333333333";
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
			if (calls.length === 1) return Response.json(namespaceId);
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
				p_namespace_id: namespaceId,
				p_name: "Shared repository",
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
		if (req.url.endsWith("/authorize_hosted_lix_creation"))
			return Response.json(namespaceId);
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
			async () => (++calls === 1 ? Response.json(namespaceId) : upstream),
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
			return Response.json(namespaceId);
		},
	});
	assert.equal(response.status, 201);
	assert.equal(calls, 3);
	assert.equal(
		response.headers.get("access-control-allow-origin"),
		"https://client.test",
	);
});

void test("account PAT creates a snapshot repository without a browser session", async () => {
	const { handleRequest } = await import("./handler.ts");
	const req = request();
	req.headers.set("authorization", `Bearer lixray_pat_${"a".repeat(64)}`);
	let authorized = false;
	const response = await handleRequest(req, env, {
		fetch: async (input, init) => {
			const upstream = new Request(input, init);
			if (upstream.url.endsWith("/authorize_api_token")) {
				assert.equal(upstream.headers.get("authorization"), null);
				assert.equal(
					((await upstream.json()) as { p_lix_id: unknown }).p_lix_id,
					null,
				);
				authorized = true;
				return Response.json([
					{
						account_id: account.userId,
						kind: "person",
						name: "Sam",
						profile_uri: null,
						allowed: true,
					},
				]);
			}
			assert.equal(authorized, true);
			if (upstream.url.endsWith("/lix/v1")) {
				assert.equal(upstream.headers.get("x-lix-account-id"), account.userId);
				return Response.json({ id }, { status: 201 });
			}
			return Response.json(namespaceId);
		},
	});
	assert.equal(response.status, 201);
});

void test("empty creation uses the same protocol path and selected namespace", async () => {
	const req = new Request("https://lixray.test/lix/v1", {
		method: "POST",
		headers: {
			"idempotency-key": "empty-key",
			"x-lixray-namespace-id": namespaceId,
			"x-lixray-repository-name": encodeURIComponent("My résumé"),
		},
	});
	const calls: string[] = [];
	const response = await createHostedRepository(
		req,
		env,
		account,
		async (input, init) => {
			const upstream = new Request(input, init);
			calls.push(new URL(upstream.url).pathname);
			if (upstream.url.endsWith("authorize_hosted_lix_creation")) {
				assert.deepEqual(await upstream.json(), {
					p_account_id: account.userId,
					p_namespace_id: namespaceId,
					p_name: "My résumé",
				});
				return Response.json(namespaceId);
			}
			if (upstream.url.endsWith("/lix/v1")) {
				assert.equal(await upstream.text(), "");
				assert.equal(upstream.headers.get("x-lixray-namespace-id"), null);
				return Response.json({ id }, { status: 201 });
			}
			assert.deepEqual(await upstream.json(), {
				p_account_id: account.userId,
				p_lix_id: id,
				p_namespace_id: namespaceId,
				p_name: "My résumé",
			});
			return new Response(null, { status: 204 });
		},
	);
	assert.equal(response.status, 201);
	assert.deepEqual(calls, [
		"/rest/v1/rpc/authorize_hosted_lix_creation",
		"/lix/v1",
		"/rest/v1/rpc/register_hosted_lix",
	]);
});

void test("a taken name is rejected before uploading", async () => {
	let calls = 0;
	const response = await createHostedRepository(
		request(),
		env,
		account,
		async () => {
			calls++;
			return Response.json(
				{ code: "23505", message: "already exists" },
				{ status: 409 },
			);
		},
	);
	assert.equal(response.status, 409);
	assert.equal(calls, 1);
	assert.match(
		(await response.json()).error.message,
		/A repository named “Shared repository” already exists/,
	);
});

void test("a name claimed during creation answers 409 at registration", async () => {
	let calls = 0;
	const response = await createHostedRepository(
		request(),
		env,
		account,
		async () => {
			calls++;
			if (calls === 1) return Response.json(namespaceId);
			if (calls === 2) return Response.json({ id }, { status: 201 });
			return new Response(null, { status: 409 });
		},
	);
	assert.equal(response.status, 409);
	assert.equal(calls, 3);
});

void test("namespace outsider is rejected before uploading", async () => {
	let calls = 0;
	const response = await createHostedRepository(
		request(),
		env,
		account,
		async () => {
			calls++;
			return new Response(null, { status: 403 });
		},
	);
	assert.equal(response.status, 403);
	assert.equal(calls, 1);
});
