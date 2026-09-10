import assert from "node:assert/strict";
import test from "node:test";
import { handlePublishedEntity } from "./published-entity.ts";
const lixId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const env = {
	SUPABASE_URL: "https://database.test",
	SUPABASE_SERVICE_ROLE_KEY: "server-secret",
};
const request = (query = `id=${id}`) =>
	new Request(
		`https://lixray.test/api/published/entity?namespace=opral&repository=monorepo&kind=file&${query}`,
	);
const fetcher: typeof fetch = async (input, init) => {
	const req = new Request(input, init);
	assert.equal(req.headers.get("authorization"), "Bearer server-secret");
	if (req.url.includes("/handles?")) {
		assert.equal(new URL(req.url).searchParams.get("handle"), "eq.opral");
		return Response.json([{ namespace_id: lixId }]);
	}
	assert.equal(new URL(req.url).searchParams.get("slug"), "eq.monorepo");
	assert.equal(new URL(req.url).searchParams.get("deleted_at"), "is.null");
	return Response.json([{ id: lixId }]);
};
void test("identity resolution authorizes the current path and ignores a supplied slug", async () => {
	const response = await handlePublishedEntity(
		request(`id=${id}&slug=public.md`),
		env,
		async (repo, kind, selector) => {
			assert.equal(repo, lixId);
			assert.equal(kind, "file");
			assert.deepEqual(selector, { id });
			return { id, path: "/private/renamed.md" };
		},
		async (repo, path) => {
			assert.equal(repo, lixId);
			assert.equal(path, "/private/renamed.md");
			return false;
		},
		fetcher,
	);
	assert.equal(response.status, 404);
	assert.doesNotMatch(await response.text(), /private|renamed|22222222/);
});
void test("published identity returns the renamed path after authorization", async () => {
	const response = await handlePublishedEntity(
		request(),
		env,
		async () => ({ id, path: "/published/new.md" }),
		async () => true,
		fetcher,
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), {
		id,
		path: "/published/new.md",
		lixId,
		kind: "file",
	});
});
void test("path to identity resolution also authorizes the actual returned path", async () => {
	const response = await handlePublishedEntity(
		request("path=%2Fpublished%2Fdoc.md"),
		env,
		async (_repo, _kind, selector) => {
			assert.deepEqual(selector, { path: "/published/doc.md" });
			return { id, path: "/published/doc.md" };
		},
		async (_repo, path) => path === "/published/doc.md",
		fetcher,
	);
	assert.equal(response.status, 200);
});
void test("deleted entities and inaccessible entities have the same response", async () => {
	const response = await handlePublishedEntity(
		request(),
		env,
		async () => null,
		async () => {
			throw new Error("should not authorize");
		},
		fetcher,
	);
	assert.equal(response.status, 404);
});
void test("malformed and ambiguous locators are rejected before any privileged lookup", async () => {
	for (const query of ["id=bad", "id=" + id + "&path=/a", "path=relative"]) {
		const response = await handlePublishedEntity(
			request(query),
			env,
			async () => {
				throw new Error("unexpected");
			},
			async () => true,
			async () => {
				throw new Error("unexpected");
			},
		);
		assert.equal(response.status, 400);
	}
});
