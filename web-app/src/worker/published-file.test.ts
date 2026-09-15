import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./handler.ts";

const lixId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const request = (path = "/public.md", id = fileId) =>
	new Request(
		`https://lixray.test/api/published/lix/${lixId}/file?${new URLSearchParams({ path, id })}`,
	);
const authorize = async () => ({
	ok: true as const,
	lixId,
	scope: "path" as const,
});

void test("authorized download uses the SDK's protocol version, exact ID/path query and session cleanup", async () => {
	const methods: string[] = [];
	const response = await handleRequest(
		request(),
		{},
		{
			resolvePublicLix: async (_id, _env, path) => {
				assert.equal(path, "/public.md");
				return authorize();
			},
			lixFetch: async (id, req) => {
				assert.equal(id, lixId);
				const version = req.headers.get("lix-server-protocol-version");
				assert.ok(
					version,
					"SDK must negotiate its protocol version automatically",
				);
				assert.equal(
					req.headers.get("x-lixray-idempotency-principal"),
					"00000000-0000-7000-8000-000000000002",
				);
				const path = new URL(req.url).pathname;
				methods.push(req.method);
				if (path === `/lix/v1/${lixId}/`)
					return Response.json({
						protocolVersion: Number(version),
						activeBranchId: "main",
						activeAccountId: "anonymous",
						sessionId: "session",
					});
				assert.equal(req.headers.get("lix-session-id"), "session");
				if (req.method === "DELETE") return new Response(null, { status: 204 });
				assert.equal(path, `/lix/v1/${lixId}/execute`);
				const body = (await req.json()) as { sql: string; params: unknown[] };
				assert.equal(
					body.sql,
					"SELECT content FROM lix_file WHERE id = $1 AND path = $2",
				);
				assert.deepEqual(body.params, [
					{ kind: "text", value: fileId },
					{ kind: "text", value: "/public.md" },
				]);
				return Response.json({
					columns: [{ name: "content", type: "blob" }],
					rows: [[{ kind: "blob", base64: "IyBQdWJsaWM=" }]],
					rowsAffected: 0,
					notices: [],
				});
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "# Public");
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(methods, ["GET", "POST", "DELETE"]);
});

void test("revoked or private paths never open a Lix session", async () => {
	const response = await handleRequest(
		request("/private.md"),
		{},
		{
			resolvePublicLix: async () => ({
				ok: false,
				response: new Response(null, { status: 404 }),
			}),
			lixFetch: async () => {
				throw new Error("must not access private content");
			},
		},
	);
	assert.equal(response.status, 404);
});

void test("ambiguous and reserved paths are rejected before authorization", async () => {
	for (const path of [
		"/public/../private.md",
		"/public//private.md",
		"/public\\private.md",
		"/.lix/settings.json",
		"/public.md\0",
	]) {
		const response = await handleRequest(
			request(path),
			{},
			{
				resolvePublicLix: async () => {
					throw new Error("must not authorize ambiguous path");
				},
			},
		);
		assert.equal(response.status, 400, path);
	}
});

for (const upstreamStatus of [426, 401, 403, 404, 500, 503]) {
	void test(`upstream ${upstreamStatus} does not falsely report unpublished`, async () => {
		const response = await handleRequest(
			request(),
			{},
			{
				resolvePublicLix: authorize,
				lixFetch: async () => new Response(null, { status: upstreamStatus }),
			},
		);
		assert.equal(response.status, upstreamStatus === 426 ? 426 : 502);
	});
}

void test("query failure still closes the server session", async () => {
	let closed = false;
	const response = await handleRequest(
		request(),
		{},
		{
			resolvePublicLix: authorize,
			lixFetch: async (_id, req) => {
				if (req.method === "GET")
					return Response.json({
						protocolVersion: Number(
							req.headers.get("lix-server-protocol-version"),
						),
						activeBranchId: "main",
						activeAccountId: "anonymous",
						sessionId: "session",
					});
				if (req.method === "DELETE") {
					closed = true;
					return new Response(null, { status: 204 });
				}
				return new Response(null, { status: 503 });
			},
		},
	);
	assert.equal(response.status, 502);
	assert.ok(closed);
});
