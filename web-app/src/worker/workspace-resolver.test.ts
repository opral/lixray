import assert from "node:assert/strict";
import test from "node:test";
import { resolveSupabaseWorkspaceId } from "./workspace-resolver.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

void test("workspace resolver returns one RLS-visible workspace", async () => {
	const result = await resolveSupabaseWorkspaceId({
		supabaseUrl: "https://project.supabase.co",
		publishableKey: "publishable-key",
		accessToken: "user-token",
		namespace: "acme",
		workspaceSlug: "launch-q3",
		fetch: async (input, init) => {
			const requestUrl =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const url = new URL(requestUrl);
			const headers = new Headers(init?.headers);
			assert.equal(url.pathname, "/rest/v1/workspaces");
			assert.equal(
				url.searchParams.get("select"),
				"id,organizations!inner(id)",
			);
			assert.equal(url.searchParams.get("slug"), "eq.launch-q3");
			assert.equal(url.searchParams.get("deleted_at"), "is.null");
			assert.equal(url.searchParams.get("organizations.handle"), "eq.acme");
			assert.equal(headers.get("apikey"), "publishable-key");
			assert.equal(headers.get("authorization"), "Bearer user-token");
			return Response.json([{ id: WORKSPACE_ID }]);
		},
	});

	assert.deepEqual(result, { ok: true, workspaceId: WORKSPACE_ID });
});

void test("workspace resolver distinguishes absence from invalid upstream data", async () => {
	const baseOptions = {
		supabaseUrl: "https://project.supabase.co",
		publishableKey: "publishable-key",
		accessToken: "user-token",
		namespace: "acme",
		workspaceSlug: "launch-q3",
	};

	assert.deepEqual(
		await resolveSupabaseWorkspaceId({
			...baseOptions,
			fetch: async () => Response.json([]),
		}),
		{ ok: false, reason: "not_found" },
	);
	assert.deepEqual(
		await resolveSupabaseWorkspaceId({
			...baseOptions,
			fetch: async () => Response.json([{ id: "not-a-uuid" }]),
		}),
		{ ok: false, reason: "unavailable" },
	);
});
