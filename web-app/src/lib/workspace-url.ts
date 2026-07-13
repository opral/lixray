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
	const normalizedNamespace = normalizeRouteSegment(namespace);
	const organization = organizations.find(
		(candidate) =>
			normalizeRouteSegment(candidate.handle) === normalizedNamespace,
	);
	if (!organization) return null;
	const normalizedWorkspaceSlug = normalizeRouteSegment(workspaceSlug);
	const workspace = organization.workspaces.find(
		(candidate) =>
			normalizeRouteSegment(candidate.slug) === normalizedWorkspaceSlug,
	);
	return workspace ? { organization, workspace } : null;
}

function normalizeRouteSegment(value: string): string {
	return value.toLowerCase().replaceAll("-", "");
}
