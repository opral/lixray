/**
 * Share URLs preserve the resource path exactly. The invite is deliberately a
 * query-state capability, so these helpers only ever add or remove that one
 * query parameter and leave every other part of the URL alone.
 */
export function stripInviteFromUrl(url: string): string {
	const hashIndex = url.indexOf("#");
	const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");
	if (queryIndex === -1) return url;

	const path = beforeHash.slice(0, queryIndex);
	const query = beforeHash.slice(queryIndex + 1);
	const retained = query.split("&").filter((part) => !isInviteParameter(part));
	return `${path}${retained.length > 0 ? `?${retained.join("&")}` : ""}${hash}`;
}

export function appendWorkspaceShareToken(
	canonicalUrl: string,
	token: string,
): string {
	const withoutInvite = stripInviteFromUrl(canonicalUrl);
	const hashIndex = withoutInvite.indexOf("#");
	const beforeHash =
		hashIndex === -1 ? withoutInvite : withoutInvite.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : withoutInvite.slice(hashIndex);
	const separator = beforeHash.includes("?") ? "&" : "?";
	return `${beforeHash}${separator}invite=${encodeURIComponent(token)}${hash}`;
}

export function canonicalPathFromLocation(location: Pick<Location, "hash" | "pathname" | "search">): string {
	return `${location.pathname}${stripInviteFromUrl(location.search)}${location.hash}`;
}

function isInviteParameter(part: string): boolean {
	const equalsIndex = part.indexOf("=");
	const name = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
	return name === "invite";
}
