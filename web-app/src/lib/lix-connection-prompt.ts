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

	const prompt = `Connect the user to Lixray's MCP.

Docs can be found under https://lixray.com/docs. This Lixray repository is ${lixReference} (${lixId}). Lixray is added as a normal MCP connector. Guide the user to add ${serverName} from the marketplace, or add the MCP manually at ${mcpUrl} and authenticate. If ${serverName} is already connected, reuse it.

Guide the user on usage of lixray.`;

	return {
		serverName,
		mcpUrl,
		documentationUrl,
		previewUrl,
		prompt,
	};
}
