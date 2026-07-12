import type { Organization, Workspace } from "~/components/workspace-provider";

export function workspacePath(
	organization: Organization,
	workspace: Workspace,
): string {
	return `/@${organization.handle}/${workspace.slug}`;
}

export function findWorkspaceByRoute(
	organizations: Array<Organization>,
	namespace: string,
	workspaceSlug: string,
): { organization: Organization; workspace: Workspace } | null {
	const organization = organizations.find(
		(candidate) => candidate.handle === namespace.toLowerCase(),
	);
	if (!organization) return null;
	const workspace = organization.workspaces.find(
		(candidate) => candidate.slug === workspaceSlug.toLowerCase(),
	);
	return workspace ? { organization, workspace } : null;
}
