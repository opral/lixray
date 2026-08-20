/** Repository home — the marketing "open the app" destination. */
export const REPOSITORY_HOME_PATH = "/home";

/**
 * Auth-aware href for landing / header / marketing CTAs.
 * Always opens home. Last-repository restore lives on `/open`, not here.
 */
export function repositoryCtaHref(signedIn: boolean): string {
	if (signedIn) return REPOSITORY_HOME_PATH;
	return `/sign-in?returnTo=${encodeURIComponent(REPOSITORY_HOME_PATH)}`;
}
