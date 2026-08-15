import type {
	Organization,
	Repository,
} from "~/components/repository-provider";

export function repositoryPath(
	organization: Organization,
	repository: Repository,
): string {
	return `/@${organization.handle}/${repository.slug}`;
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

export function findRepositoryByRoute(
	organizations: Array<Organization>,
	namespace: string,
	repositorySlug: string,
): { organization: Organization; repository: Repository } | null {
	const normalizedNamespace = normalizeRouteSegment(namespace);
	const organization = organizations.find(
		(candidate) =>
			normalizeRouteSegment(candidate.handle) === normalizedNamespace,
	);
	if (!organization) return null;
	const normalizedRepositorySlug = normalizeRouteSegment(repositorySlug);
	const repository = organization.repositories.find(
		(candidate) =>
			normalizeRouteSegment(candidate.slug) === normalizedRepositorySlug,
	);
	return repository ? { organization, repository } : null;
}

function normalizeRouteSegment(value: string): string {
	return value.toLowerCase().replaceAll("-", "");
}
