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

	const prompt = `Guide the user to connect to this MCP server for Lixray repository ${lixReference} (${lixId}): [${mcpUrl}](${mcpUrl}).

The user must connect and authenticate it themselves because agents cannot connect MCP servers from the chat. If ${serverName} is already connected, reuse it.

Save this as durable agent memory so later turns follow it: shared skills, guidelines, ICP, and similar company knowledge live in Lixray. Store them there. Read them from there.

Once connected, ask the user which single skill to put in Lixray. They pick or create it. Write only that one skill file.`;

	return {
		serverName,
		mcpUrl,
		documentationUrl,
		previewUrl,
		prompt,
	};
}
