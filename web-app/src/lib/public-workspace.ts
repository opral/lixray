import type { LixraySupabaseClient } from "~/lib/supabase";

export interface PublicWorkspaceRoute {
	readonly organizationId: string;
	readonly organizationName: string;
	readonly organizationHandle: string;
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly workspaceSlug: string;
	readonly canEdit: boolean;
}

export class TeamInviteAccessConfirmationError extends Error {
	readonly name = "TeamInviteAccessConfirmationError";
}

interface ResolvedWorkspaceShare extends Omit<PublicWorkspaceRoute, "canEdit"> {
	readonly sharedByName: string | null;
	readonly sharedByAvatarUrl: string | null;
	/** The token's grant, not the current viewer's edit membership. */
	readonly grantsEdit: boolean;
}

export async function resolvePublicWorkspaceByRoute(
	client: LixraySupabaseClient,
	organizationHandle: string,
	workspaceSlug: string,
): Promise<PublicWorkspaceRoute | null> {
	const { data, error } = await client.rpc("resolve_public_lix_by_route", {
		p_namespace_handle: organizationHandle,
		p_lix_slug: workspaceSlug,
	});
	if (error) throw error;
	return data?.[0] ? publicWorkspaceRoute(data[0]) : null;
}

/**
 * Accepts a namespace invite and then verifies that the current session can
 * edit the repository from the invite URL. Callers must not open the writable
 * Atelier until this promise resolves.
 */
export async function acceptTeamInviteForWorkspace(
	client: LixraySupabaseClient,
	token: string,
	organizationHandle: string,
	workspaceSlug: string,
	expectedWorkspaceId: string,
): Promise<{
	readonly joinedNamespaceName: string | null;
	readonly workspace: PublicWorkspaceRoute;
}> {
	const { data, error } = await client.rpc("accept_namespace_invite", {
		p_token: token,
	});
	if (error) throw error;

	let workspace: PublicWorkspaceRoute | null;
	try {
		workspace = await resolvePublicWorkspaceByRoute(
			client,
			organizationHandle,
			workspaceSlug,
		);
	} catch (cause) {
		throw new TeamInviteAccessConfirmationError(
			"The invite was accepted, but edit access could not be refreshed.",
			{ cause },
		);
	}
	if (
		!workspace ||
		workspace.workspaceId !== expectedWorkspaceId ||
		!workspace.canEdit
	) {
		throw new TeamInviteAccessConfirmationError(
			"The invite was accepted, but edit access is not available.",
		);
	}

	return {
		joinedNamespaceName: data?.[0]?.namespace_name ?? null,
		workspace,
	};
}

export async function resolveWorkspaceShareToken(
	client: LixraySupabaseClient,
	token: string,
): Promise<ResolvedWorkspaceShare | null> {
	const { data, error } = await client.rpc("resolve_lix_share_token", {
		p_token: token,
	});
	if (error) throw error;
	const row = data?.[0];
	if (!row) return null;
	const { canEdit: grantsEdit, ...workspace } = publicWorkspaceRoute(row);
	return {
		...workspace,
		sharedByName: row.shared_by_name,
		sharedByAvatarUrl: row.shared_by_avatar_url,
		grantsEdit,
	};
}

function publicWorkspaceRoute(row: {
	namespace_id: string;
	namespace_name: string;
	namespace_handle: string;
	lix_id: string;
	lix_name: string;
	lix_slug: string;
	can_edit: boolean;
}): PublicWorkspaceRoute {
	return {
		organizationId: row.namespace_id,
		organizationName: row.namespace_name,
		organizationHandle: row.namespace_handle,
		workspaceId: row.lix_id,
		workspaceName: row.lix_name,
		workspaceSlug: row.lix_slug,
		canEdit: row.can_edit,
	};
}
