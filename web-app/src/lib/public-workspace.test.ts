import assert from "node:assert/strict";
import { test } from "node:test";
import type { LixraySupabaseClient } from "./supabase.ts";
import {
	acceptTeamInviteForWorkspace,
	TeamInviteAccessConfirmationError,
} from "./public-workspace.ts";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function clientReturning(canEdit: boolean) {
	const calls: string[] = [];
	const client = {
		rpc: async (name: string) => {
			calls.push(name);
			if (name === "accept_namespace_invite") {
				return {
					data: [{ namespace_name: "Atelier" }],
					error: null,
				};
			}
			return {
				data: [
					{
						namespace_id: "11111111-1111-4111-8111-111111111111",
						namespace_name: "Atelier",
						namespace_handle: "atelier",
						lix_id: WORKSPACE_ID,
						lix_name: "Website",
						lix_slug: "website",
						can_edit: canEdit,
					},
				],
				error: null,
			};
		},
	} as unknown as LixraySupabaseClient;
	return { calls, client };
}

void test("team invite acceptance confirms edit access before resolving", async () => {
	const { calls, client } = clientReturning(true);
	const result = await acceptTeamInviteForWorkspace(
		client,
		"tm_AAAAAAAAAAAAAAAAAAAA",
		"atelier",
		"website",
		WORKSPACE_ID,
	);

	assert.deepEqual(calls, [
		"accept_namespace_invite",
		"resolve_public_lix_by_route",
	]);
	assert.equal(result.joinedNamespaceName, "Atelier");
	assert.equal(result.workspace.canEdit, true);
});

void test("team invite acceptance rejects a stale read-only route", async () => {
	const { client } = clientReturning(false);
	await assert.rejects(
		acceptTeamInviteForWorkspace(
			client,
			"tm_AAAAAAAAAAAAAAAAAAAA",
			"atelier",
			"website",
			WORKSPACE_ID,
		),
		(caught) =>
			caught instanceof TeamInviteAccessConfirmationError &&
			/edit access is not available/.test(caught.message),
	);
});
