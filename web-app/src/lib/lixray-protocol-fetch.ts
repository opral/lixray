import type { RemoteLixFetch } from "@lix-js/sdk";

export function canonicalLixUrl(origin: string | URL, lixId: string): URL {
	return new URL(`/lix/${encodeURIComponent(lixId)}`, origin);
}

/**
 * Lix identifies a repository through `/lix/{uuid}`. LixRay keeps its public
 * namespace/slug route, so adapt transport requests without weakening the
 * canonical locator that the SDK validates and uses as replica identity.
 */
export function createLixrayProtocolFetch(options: {
	lixId: string;
	namespace: string;
	repositorySlug: string;
	fetch?: RemoteLixFetch;
}): RemoteLixFetch {
	const canonicalPrefix = `/lix/${encodeURIComponent(options.lixId)}`;
	const hostedProtocolPrefix = `${canonicalPrefix}/lix/v1/${encodeURIComponent(options.lixId)}`;
	const syncProtocolPrefix = `/lix/v1/${encodeURIComponent(options.lixId)}`;
	const lixrayPrefix = `/@${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.repositorySlug)}`;
	const protocolFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	return (input, init) => {
		const request =
			input instanceof Request ? new Request(input, init) : undefined;
		const url = new URL(
			request?.url ??
				(typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url),
		);
		const protocolPrefix = [hostedProtocolPrefix, syncProtocolPrefix].find(
			(prefix) =>
				url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
		);
		if (protocolPrefix === undefined) {
			throw new TypeError(
				"Lix protocol request does not match its canonical ID",
			);
		}
		const suffix = url.pathname.slice(protocolPrefix.length);
		url.pathname = `${lixrayPrefix}/lix/v1${suffix || "/"}`;
		// The worker sync bridge supplies a URL plus RequestInit. Keep that init
		// intact so streamed/typed-array push bodies survive the route rewrite.
		// Reconstruct only when the caller supplied a Request object.
		return request === undefined
			? protocolFetch(url, init)
			: protocolFetch(new Request(url, request));
	};
}
