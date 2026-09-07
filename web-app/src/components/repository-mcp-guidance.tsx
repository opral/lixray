/** Kept in the root shell because repository routes are client-rendered. */
export function RepositoryMcpGuidance({
	pathname,
	searchStr,
}: {
	pathname: string;
	searchStr: string;
}) {
	const match = /^\/(?:@|%40)([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(pathname);
	if (!match) return null;
	let repository: string;
	let file: string | undefined;
	try {
		repository = `@${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
		file = match[3]?.startsWith("file/")
			? decodeURIComponent(match[3].slice("file/".length))
			: undefined;
	} catch {
		return null;
	}
	const branch = new URLSearchParams(searchStr).get("branch")?.trim();
	const args = JSON.stringify({
		lix_ref: repository,
		...(branch ? { branch_id: branch } : {}),
	});
	return (
		<section
			aria-label="Access through LixRay MCP"
			className="border-t bg-background px-6 py-4 text-sm text-muted-foreground"
		>
			<p>
				This {file ? "document" : "repository"} is available through LixRay MCP.
			</p>
			<p>
				Repository: <code>{repository}</code>
			</p>
			{file && (
				<p>
					File: <code>{file}</code>
				</p>
			)}
			{branch && (
				<p>
					Branch: <code>{branch}</code>
				</p>
			)}
			<p>
				If a LixRay connector is available, call <code>open_lix</code> with{" "}
				<code>{args}</code>. Use the returned context from{" "}
				<code>structuredContent</code> for subsequent MCP calls. Otherwise, ask
				the user to connect LixRay using the{" "}
				<a className="underline" href="/mcp/docs">
					MCP setup documentation
				</a>
				.
			</p>
			<p>
				MCP endpoint:{" "}
				<a className="underline" href="https://lixray.com/mcp">
					https://lixray.com/mcp
				</a>
			</p>
		</section>
	);
}
