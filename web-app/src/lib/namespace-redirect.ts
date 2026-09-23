/** Preserve a deep link and its query/fragment when a namespace handle changes. */
export function canonicalNamespaceHref(
	currentHref: string,
	requestedHandle: string,
	canonicalHandle: string,
): string | null {
	if (requestedHandle === canonicalHandle) return null;
	const url = new URL(currentHref);
	const oldPrefix = `/@${requestedHandle}`;
	if (url.pathname !== oldPrefix && !url.pathname.startsWith(`${oldPrefix}/`)) {
		return null;
	}
	url.pathname = `/@${canonicalHandle}${url.pathname.slice(oldPrefix.length)}`;
	return url.href;
}
