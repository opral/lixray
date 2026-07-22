import type { Organization, Workspace } from "~/components/workspace-provider";

export function workspacePath(
	organization: Organization,
	workspace: Workspace,
): string {
	return `/@${organization.handle}/${workspace.slug}`;
}

/** Normalizes to a leading- and trailing-slash directory path; "" becomes "/". */
export function normalizeDirPath(raw: unknown): string {
	if (typeof raw !== "string" || !raw) {
		return "/";
	}
	const segments = raw.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return "/";
	}
	return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
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
