import type { RemoteLixFetch } from "@lix-js/sdk";
/** Explicit control-plane action; protocol GETs never create repository storage. */
export async function provisionRepository(
	repositoryId: string,
	token: string,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(
		`/api/repositories/${encodeURIComponent(repositoryId)}/provision`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			signal,
		},
	);
	if (!response.ok)
		throw new Error(`Repository provisioning failed (${response.status})`);
}

/** Runs only when the SDK contacts the remote. A cached offline open stays local. */
export function createProvisioningFetch(options: {
	repositoryId: string;
	getAccessToken: () => Promise<string | null>;
	allowAnonymous?: boolean;
	fetch?: RemoteLixFetch;
}): RemoteLixFetch {
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	let provisioned: Promise<Response | null> | undefined;
	return async (input, init) => {
		if (!options.allowAnonymous) {
			const pending = (provisioned ??= (async () => {
				const headers = new Headers(
					init?.headers ??
						(input instanceof Request ? input.headers : undefined),
				);
				const authorization = headers.get("authorization");
				const token = authorization?.startsWith("Bearer ")
					? authorization.slice(7)
					: await options.getAccessToken();
				if (!token) throw new Error("A repository access token is required.");
				const origin = new URL(
					input instanceof Request ? input.url : String(input),
				).origin;
				const response = await fetcher(
					`${origin}/api/repositories/${encodeURIComponent(options.repositoryId)}/provision`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${token}` },
						signal: init?.signal,
					},
				);
				return response.ok ? null : response;
			})().catch((error) => {
				provisioned = undefined;
				throw error;
			}));
			const failure = await pending;
			if (failure) {
				if (provisioned === pending) provisioned = undefined;
				// Each concurrent caller owns its response body; the outer
				// authentication transport can inspect 401 and retry normally.
				return failure.clone();
			}
		}
		return fetcher(input, init);
	};
}
