import { parseEntityUrlSplat } from "../lib/entity-url.ts";

/** Kept in the root shell because repository routes are client-rendered. */
export function RepositoryMcpGuidance({
	pathname,
	searchStr,
	visible = false,
}: {
	pathname: string;
	searchStr: string;
	visible?: boolean;
}) {
	const match = /^\/(?:@|%40)([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(pathname);
	if (!match) return null;
	let repository: string;
	let entity: { id: string; kind: "file" | "directory" } | undefined;
	try {
		repository = `@${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
		const route = /^(file|dir)\/(.*)$/.exec(match[3] ?? "");
		if (route) {
			const parsed = parseEntityUrlSplat(route[2]);
			if (!parsed) return null;
			entity = {
				id: parsed.id,
				kind: route[1] === "file" ? "file" : "directory",
			};
		}
	} catch {
		return null;
	}
	const query = entity
		? JSON.stringify({
				sql: `SELECT id, path FROM ${entity.kind === "file" ? "lix_file" : "lix_directory"} WHERE id = $1`,
				params: [{ kind: "text", value: entity.id }],
			})
		: undefined;
	const branch = new URLSearchParams(searchStr).get("branch")?.trim();
	const args = JSON.stringify({
		lix_ref: repository,
		...(branch ? { branch_id: branch } : {}),
	});
	return (
		<section
			aria-label="Access through LixRay MCP"
			className={
				visible
					? "space-y-3 text-sm text-text-tertiary [&_code]:break-all [&_code]:text-text-secondary"
					: "sr-only focus-within:not-sr-only focus-within:block focus-within:bg-bg-app focus-within:p-6"
			}
		>
			<p>
				To check access and read this {entity?.kind ?? "repository"}, use LixRay
				MCP. Availability depends on the connected account's permissions and
				whether the {entity?.kind ?? "repository"} exists.
			</p>
			<p>
				Repository: <code>{repository}</code>
			</p>
			{entity && (
				<p>
					{entity.kind === "file" ? "File" : "Directory"} ID:{" "}
					<code>{entity.id}</code>
				</p>
			)}
			{branch && (
				<p>
					Branch: <code>{branch}</code>
				</p>
			)}
			<p>
				If a LixRay connector is available, call <code>open_lix</code> with{" "}
				<code>{args}</code>. On success, use the returned context from{" "}
				<code>structuredContent</code> with <code>query_sql</code> to read the
				{entity ? " specified item" : " repository"}. Report access or
				missing-file errors without assuming availability. If no connector is
				available, ask the user to connect LixRay using the{" "}
				<a className="underline" href="/mcp/docs">
					MCP setup documentation
				</a>
				.
			</p>
			{query && (
				<p>
					Resolve the item's current path in the selected branch with{" "}
					<code>query_sql</code>, adding the returned <code>context</code> to
					these arguments: <code>{query}</code>. Use the resulting path to read
					the item. The URL label is descriptive and is not a file path. If no
					row is returned, the item does not exist in that branch; do not
					substitute a similarly named item.
				</p>
			)}
			<p>
				MCP endpoint:{" "}
				<a className="underline" href="https://lixray.com/mcp">
					https://lixray.com/mcp
				</a>
			</p>
		</section>
	);
}
