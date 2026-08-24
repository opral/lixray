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

	const prompt = `Lixray is a host for Lix repositories. Documentation is under https://lixray.com/docs.

This Lixray repository is ${lixReference} (${lixId}). Ask the user whether it is for personal stuff or company stuff, then treat it that way.

Lixray is added as a normal MCP connector. Guide the user to add ${serverName} from the cloud marketplace, or add the MCP manually at ${mcpUrl} and authenticate. If ${serverName} is already connected, reuse it.

Skills, guidelines, and working files live here. Read from it and write to it. If Lixray is not connected, tell the user to add ${mcpUrl} and reopen the chat.

Once connected, ask the user which single skill to put in Lixray. They pick or create it. Write only that one skill file.`;

	return {
		serverName,
		mcpUrl,
		documentationUrl,
		previewUrl,
		prompt,
	};
}
