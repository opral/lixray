import assert from "node:assert/strict";
import test from "node:test";
import { resolveSupabaseLixId } from "./lix-resolver.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";

void test("lix resolver returns one RLS-visible lix", async () => {
	const result = await resolveSupabaseLixId({
		supabaseUrl: "https://project.supabase.co",
		publishableKey: "publishable-key",
		accessToken: "user-token",
		namespace: "acme",
		lixSlug: "launch-q3",
		fetch: async (input, init) => {
			const requestUrl =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const url = new URL(requestUrl);
			const headers = new Headers(init?.headers);
			assert.equal(url.pathname, "/rest/v1/rpc/resolve_public_lix_by_route");
			assert.equal(init?.method, "POST");
			assert.equal(typeof init?.body, "string");
			if (typeof init?.body !== "string") {
				throw new TypeError("Expected a JSON request body");
			}
			assert.deepEqual(JSON.parse(init.body), {
				p_namespace_handle: "acme",
				p_lix_slug: "launch-q3",
			});
			assert.equal(headers.get("apikey"), "publishable-key");
			assert.equal(headers.get("authorization"), "Bearer user-token");
			return Response.json([{ lix_id: LIX_ID, can_edit: true }]);
		},
	});

	assert.deepEqual(result, { ok: true, lixId: LIX_ID });
});

void test("lix resolver distinguishes absence from invalid upstream data", async () => {
	const baseOptions = {
		supabaseUrl: "https://project.supabase.co",
		publishableKey: "publishable-key",
		accessToken: "user-token",
		namespace: "acme",
		lixSlug: "launch-q3",
	};

	assert.deepEqual(
		await resolveSupabaseLixId({
			...baseOptions,
			fetch: async () => Response.json([]),
		}),
		{ ok: false, reason: "not_found" },
	);
	assert.deepEqual(
		await resolveSupabaseLixId({
			...baseOptions,
			fetch: async () => Response.json([{ lix_id: LIX_ID, can_edit: false }]),
		}),
		{ ok: false, reason: "not_found" },
	);
	assert.deepEqual(
		await resolveSupabaseLixId({
			...baseOptions,
			fetch: async () => Response.json([{ lix_id: "not-a-uuid" }]),
		}),
		{ ok: false, reason: "unavailable" },
	);
});
