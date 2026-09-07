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
			className={
				visible
					? "space-y-3 text-sm text-text-tertiary [&_code]:break-all [&_code]:text-text-secondary"
					: "sr-only focus-within:not-sr-only focus-within:block focus-within:bg-bg-app focus-within:p-6"
			}
		>
			<p>
				To check access and read this {file ? "file" : "repository"}, use LixRay
				MCP. Availability depends on the connected account's permissions and
				whether the {file ? "file" : "repository"} exists.
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
				<code>{args}</code>. On success, use the returned context from{" "}
				<code>structuredContent</code> with <code>query_sql</code> to read the
				{file ? " specified file" : " repository"}. Report access or
				missing-file errors without assuming availability. If no connector is
				available, ask the user to connect LixRay using the{" "}
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
