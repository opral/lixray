export type LixConnectionPromptInput = {
	readonly origin: string;
	readonly lixId: string;
	readonly namespace: string;
	readonly lixSlug: string;
	readonly lixName: string;
};

export type LixConnectionDetails = {
	readonly serverName: "LixRay" | "LixRay Dev";
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
	lixName,
}: LixConnectionPromptInput): LixConnectionDetails {
	const url = new URL(origin);
	const normalizedOrigin = url.origin;
	const isLocalDevelopment = LOCAL_HOSTNAMES.has(url.hostname);
	const serverName = isLocalDevelopment ? "LixRay Dev" : "LixRay";
	const mcpUrl = `${normalizedOrigin}/mcp`;
	const documentationUrl = `${normalizedOrigin}/docs/mcp`;
	const previewUrl = `${normalizedOrigin}/@${encodeURIComponent(namespace)}/${encodeURIComponent(lixSlug)}`;
	const lixReference = `@${namespace}/${lixSlug}`;
	const localSafety = isLocalDevelopment
		? "\nThis is a local development Lix. Do not reuse a production LixRay connection for it."
		: "";

	const prompt = `Connect this agent to my Lix workspace. LixRay hosts the Lix; treat Lix as the workspace and data model, and LixRay as its host.

Use this exact Lix:
- Reference: ${lixReference}
- Name: ${lixName}
- Lix ID: ${lixId}
- Preview: ${previewUrl}

Connect this MCP server:
- Name: ${serverName}
- URL: ${mcpUrl}
- Documentation: ${documentationUrl}

First inspect the existing global MCP configuration. Reuse a server only if both its name and URL match exactly. Otherwise create or replace that registration, then complete OAuth.${localSafety}

If the newly connected MCP server requires a fresh agent task, create it and continue the setup there. Call list_lixes through "${serverName}" and verify that ${lixReference} resolves to the exact Lix ID ${lixId}. Do not use a remembered or similarly named Lix.

Once connected, inspect the recent working context available to this agent or session and propose a short, specific ingestion plan before writing anything. Prompt me with likely useful choices based on:
- files I recently opened, edited, downloaded, or discussed;
- skills or agent instructions I recently used;
- knowledge-base material such as notes, docs, specs, research, meeting notes, FAQs, and reference folders.

Prefer recent, high-signal material, especially knowledge-base content. Ask which suggested files, folders, or skills I want to ingest, and offer a manual path if recent context is unavailable. Do not ingest, create, or modify anything until I confirm.

After I confirm, ingest only the selected material into the exact Lix ID ${lixId}. Verify every write by reading it back, and report the resulting paths and change IDs.`;

	return {
		serverName,
		mcpUrl,
		documentationUrl,
		previewUrl,
		prompt,
	};
}
