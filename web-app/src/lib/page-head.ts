/** Route-owned metadata keeps browser windows and share previews in sync. */
export function pageHead(title: string, description: string) {
	return {
		meta: [
			{ title },
			{ name: "description", content: description },
			{ property: "og:title", content: title },
			{ property: "og:description", content: description },
			{ property: "og:site_name", content: "LixRay" },
			{ property: "og:type", content: "website" },
			{ name: "twitter:card", content: "summary" },
			{ name: "twitter:title", content: title },
			{ name: "twitter:description", content: description },
		],
	};
}

export function repositoryHead(
	params: { namespace: string; repository: string; _splat?: string },
	view?: "file" | "dir" | "team" | "settings" | "sql",
) {
	const repository = `@${params.namespace}/${params.repository}`;
	const path = params._splat?.replace(/^\/+|\/+$/g, "");
	const detail =
		view === "team"
			? "People"
			: view === "settings"
				? "Settings"
				: view === "sql"
					? "SQL"
					: path
						? `${path}${view === "dir" ? "/" : ""}`
						: undefined;
	const root = `/@${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.repository)}`;
	const suffix =
		view === "team" || view === "settings" || view === "sql"
			? `/${view}`
			: view
				? `/${view}/${(path ?? "").split("/").map(encodeURIComponent).join("/")}`
				: "";
	return {
		links: [{ rel: "canonical", href: root + suffix }],
		...pageHead(
			`${repository}${detail ? ` · ${detail}` : ""} — LixRay`,
			`${detail ? `${detail} in` : "Explore"} ${repository} on LixRay.`,
		),
	};
}
