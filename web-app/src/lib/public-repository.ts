import type { LixraySupabaseClient } from "~/lib/supabase";

export interface PublicRepositoryRoute {
	readonly organizationId: string;
	readonly organizationName: string;
	readonly organizationHandle: string;
	readonly repositoryId: string;
	readonly repositoryName: string;
	readonly repositorySlug: string;
	readonly canEdit: boolean;
	readonly role: "admin" | "member" | null;
	readonly visibility: "private" | "public";
	readonly pathPublic: boolean;
}

export class TeamInviteAccessConfirmationError extends Error {
	readonly name = "TeamInviteAccessConfirmationError";
}

export interface ResolvedRepositoryShare extends Omit<
	PublicRepositoryRoute,
	"canEdit"
> {
	readonly sharedByName: string | null;
	readonly sharedByAvatarUrl: string | null;
	/** The token's grant, not the current viewer's edit membership. */
	readonly grantsEdit: boolean;
}

export async function resolvePublicRepositoryByRoute(
	client: LixraySupabaseClient,
	organizationHandle: string,
	repositorySlug: string,
	publicPath?: string,
): Promise<PublicRepositoryRoute | null> {
	const { data, error } = await client.rpc("resolve_public_lix_by_route", {
		p_namespace_handle: organizationHandle,
		p_lix_slug: repositorySlug,
		...(publicPath ? { p_path: publicPath } : {}),
	});
	if (error) throw error;
	return data?.[0] ? publicRepositoryRoute(data[0]) : null;
}

/**
 * Accepts a namespace invite and then verifies that the current session can
 * edit the repository from the invite URL. Callers must not open the writable
 * Atelier until this promise resolves.
 */
export async function acceptTeamInviteForRepository(
	client: LixraySupabaseClient,
	token: string,
	organizationHandle: string,
	repositorySlug: string,
): Promise<{
	readonly joinedNamespaceName: string | null;
	readonly repository: PublicRepositoryRoute;
}> {
	const { data, error } = await client.rpc("accept_namespace_invite", {
		p_token: token,
	});
	if (error) throw error;

	let repository: PublicRepositoryRoute | null;
	try {
		repository = await resolvePublicRepositoryByRoute(
			client,
			organizationHandle,
			repositorySlug,
		);
	} catch (cause) {
		throw new TeamInviteAccessConfirmationError(
			"The invite was accepted, but edit access could not be refreshed.",
			{ cause },
		);
	}
	if (!repository || !repository.canEdit) {
		throw new TeamInviteAccessConfirmationError(
			"The invite was accepted, but edit access is not available.",
		);
	}

	return {
		joinedNamespaceName: data?.[0]?.namespace_name ?? null,
		repository,
	};
}

export async function resolveRepositoryShareToken(
	client: LixraySupabaseClient,
	token: string,
): Promise<ResolvedRepositoryShare | null> {
	const { data, error } = await client.rpc("resolve_lix_share_token", {
		p_token: token,
	});
	if (error) throw error;
	const row = data?.[0];
	if (!row) return null;
	const { canEdit: grantsEdit, ...repository } = publicRepositoryRoute({
		...row,
		role: row.role,
		visibility: row.visibility,
		path_public: row.path_public,
	});
	return {
		...repository,
		sharedByName: row.shared_by_name,
		sharedByAvatarUrl: row.shared_by_avatar_url,
		grantsEdit,
	};
}

function publicRepositoryRoute(row: {
	namespace_id: string;
	namespace_name: string;
	namespace_handle: string;
	lix_id: string;
	lix_name: string;
	lix_slug: string;
	can_edit: boolean;
	role: "admin" | "member" | null;
	visibility: "private" | "public";
	path_public: boolean;
}): PublicRepositoryRoute {
	return {
		organizationId: row.namespace_id,
		organizationName: row.namespace_name,
		organizationHandle: row.namespace_handle,
		repositoryId: row.lix_id,
		repositoryName: row.lix_name,
		repositorySlug: row.lix_slug,
		canEdit: row.can_edit,
		role: row.role,
		visibility: row.visibility,
		pathPublic: row.path_public,
	};
}
