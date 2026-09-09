import assert from "node:assert/strict";
import test from "node:test";
import { handleFileSharing } from "./repository-file-sharing.ts";
const id = "11111111-1111-4111-8111-111111111111";
const env = {
	SUPABASE_URL: "https://database.test",
	SUPABASE_PUBLISHABLE_KEY: "public",
};
void test("publication uses the user token and a file-only grant", async () => {
	const calls: Request[] = [];
	const response = await handleFileSharing(
		new Request(
			`https://lixray.test/api/repositories/${id}/share?path=${encodeURIComponent("/notes/Hello world.md")}`,
			{ method: "POST" },
		),
		env,
		"desktop-token",
		id,
		async (input, init) => {
			const request = new Request(input, init);
			calls.push(request);
			assert.equal(
				request.headers.get("authorization"),
				"Bearer desktop-token",
			);
			if (calls.length === 1)
				return Response.json([
					{
						lix_id: id,
						lix_visibility: "private",
						namespace_handle: "sam",
						lix_slug: "notes",
					},
				]);
			if (calls.length === 2) return Response.json([]);
			assert.deepEqual(await request.json(), {
				p_lix_id: id,
				p_path: "/notes/Hello world.md",
				p_kind: "file",
			});
			return new Response(null, { status: 204 });
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		published: true,
		inherited: false,
		url: "https://lixray.test/@sam/notes/file/notes/Hello%20world.md",
	});
});
void test("unpublishing a file cannot remove inherited publication", async () => {
	let calls = 0;
	const response = await handleFileSharing(
		new Request(
			`https://lixray.test/api/repositories/${id}/share?path=/notes/a.md`,
			{ method: "DELETE" },
		),
		env,
		"token",
		id,
		async () => {
			calls++;
			return Response.json(
				calls === 1
					? [
							{
								lix_id: id,
								lix_visibility: "private",
								namespace_handle: "sam",
								lix_slug: "notes",
							},
						]
					: [{ kind: "directory", path: "/notes" }],
			);
		},
	);
	assert.equal(response.status, 409);
	assert.equal(calls, 2);
});
