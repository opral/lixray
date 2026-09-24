import { openLix } from "@lix-js/sdk";
import type { WorkerEnv } from "./handler.ts";
import { lixServiceRequestHeaders } from "../lib/lix-service-proxy.ts";

// Pinned release: https://github.com/opral/lix/releases/tag/plugin_markdown/v0.1.0
export const MARKDOWN_PLUGIN_ASSET = "/plugins/plugin_markdown.lixplugin";
export const MARKDOWN_PLUGIN_PATH = "/.lix/plugins/plugin_markdown.lixplugin";

/** Install on the new host's active branch before its locator becomes public. */
export async function installMarkdownPlugin(
	request: Request,
	env: WorkerEnv,
	account: { userId: string },
	repositoryId: string,
	fetcher: typeof fetch = fetch,
	open: typeof openLix = openLix,
): Promise<void> {
	const asset = await fetcher(new URL(MARKDOWN_PLUGIN_ASSET, request.url));
	if (!asset.ok) {
		await asset.body?.cancel();
		throw new Error(`Markdown plugin asset returned ${asset.status}`);
	}
	const archive = new Uint8Array(await asset.arrayBuffer());
	if (archive.byteLength === 0)
		throw new Error("Markdown plugin archive is empty");

	const service =
		env.LIXRAY_LIX_SERVICE_URL ??
		env.LIXRAY_REPOSITORY_SERVICE_URL ??
		env.LIXRAY_WORKSPACE_SERVICE_URL;
	if (!service || !env.LIXRAY_INTERNAL_TOKEN)
		throw new Error("Lix service is not configured");
	const lix = await open({
		server: {
			url: new URL(`/lix/${repositoryId}`, request.url).href,
			headers: {
				"x-lixray-idempotency-principal": account.userId,
			},
			fetch: (input, init) => {
				const protocolRequest = new Request(input, init);
				const target = new URL(protocolRequest.url);
				const upstream = new URL(service);
				upstream.pathname = target.pathname;
				upstream.search = target.search;
				return fetcher(new Request(upstream, protocolRequest), {
					headers: lixServiceRequestHeaders(
						protocolRequest.headers,
						env.LIXRAY_INTERNAL_TOKEN!,
					),
				});
			},
		},
	});
	try {
		await lix.execute(
			`INSERT INTO lix_file (path, content) VALUES ($1, $2)
			 ON CONFLICT (path) DO NOTHING`,
			[MARKDOWN_PLUGIN_PATH, archive],
		);
	} finally {
		await lix.close();
	}
}
