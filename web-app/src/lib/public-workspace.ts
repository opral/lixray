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

export interface ResolvedWorkspaceShare
	extends Omit<PublicWorkspaceRoute, "canEdit"> {
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
	const { data, error } = await client.rpc(
		"resolve_public_workspace_by_route",
		{
			p_organization_handle: organizationHandle,
			p_workspace_slug: workspaceSlug,
		},
	);
	if (error) throw error;
	return data?.[0] ? publicWorkspaceRoute(data[0]) : null;
}

export async function resolveWorkspaceShareToken(
	client: LixraySupabaseClient,
	token: string,
): Promise<ResolvedWorkspaceShare | null> {
	const { data, error } = await client.rpc("resolve_workspace_share_token", {
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
	organization_id: string;
	organization_name: string;
	organization_handle: string;
	workspace_id: string;
	workspace_name: string;
	workspace_slug: string;
	can_edit: boolean;
}): PublicWorkspaceRoute {
	return {
		organizationId: row.organization_id,
		organizationName: row.organization_name,
		organizationHandle: row.organization_handle,
		workspaceId: row.workspace_id,
		workspaceName: row.workspace_name,
		workspaceSlug: row.workspace_slug,
		canEdit: row.can_edit,
	};
}
