export type LixConnectionPromptInput = {
	readonly origin: string;
	readonly lixId: string;
	readonly namespace: string;
	readonly lixSlug: string;
	readonly lixName: string;
};

export type LixConnectionDetails = {
	readonly serverName: "LixRay" | "LixRay_Dev";
	readonly mcpUrl: string;
	readonly documentationUrl: string;
	readonly previewUrl: string;
	readonly prompt: string;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function createLixConnectionDetails({
	origin,
	lixId,
	namespace,
	lixSlug,
}: LixConnectionPromptInput): LixConnectionDetails {
	const url = new URL(origin);
	const normalizedOrigin = url.origin;
	const isLocalDevelopment = LOCAL_HOSTNAMES.has(url.hostname);
	const serverName = isLocalDevelopment ? "LixRay_Dev" : "LixRay";
	const mcpUrl = `${normalizedOrigin}/mcp`;
	const documentationUrl = `${normalizedOrigin}/docs/mcp`;
	const previewUrl = `${normalizedOrigin}/@${encodeURIComponent(namespace)}/${encodeURIComponent(lixSlug)}`;
	const lixReference = `@${namespace}/${lixSlug}`;

	const prompt = `Connect this agent to my Lix workspace \`${lixReference}\`.

Use the \`${serverName}\` MCP connection for Lix \`${lixId}\`. If that connection already exists, reuse it. Otherwise, create and authenticate it with ${mcpUrl}. Never open either URL in a browser.

If you cannot connect, stop and tell me exactly what I need to do next.

Call active_branch_id with this exact Lix ID. Once verified, ask me for the first files. Do not inspect unrelated apps or files or write yet.`;

	return {
		serverName,
		mcpUrl,
		documentationUrl,
		previewUrl,
		prompt,
	};
}
