/** Opens the selected repository, provisioning one for a new browser account. */
export const REPOSITORY_HOME_PATH = "/open";

/**
 * Auth-aware href for landing / header / marketing CTAs.
 * Opens the repository selected by the browser, or a new user's first repo.
 */
export function repositoryCtaHref(signedIn: boolean): string {
	if (signedIn) return REPOSITORY_HOME_PATH;
	return `/sign-in?returnTo=${encodeURIComponent(REPOSITORY_HOME_PATH)}`;
}
