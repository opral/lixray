import { parseEntityUrlSplat } from "./entity-url.ts";

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
	view?: "file" | "folder" | "team" | "settings" | "sql",
	search: { branch?: string } = {},
) {
	const repository = `@${params.namespace}/${params.repository}`;
	const path = params._splat?.replace(/^\/+|\/+$/g, "");
	const entity =
		view === "file" || view === "folder" ? parseEntityUrlSplat(path) : null;
	const detail =
		view === "team"
			? "People"
			: view === "settings"
				? "Settings"
				: view === "sql"
					? "SQL"
					: view === "file" || view === "folder"
						? (entity?.name ?? (view === "file" ? "File" : "Folder"))
						: undefined;
	const root = `/@${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.repository)}`;
	const suffix =
		view === "team" || view === "settings" || view === "sql"
			? `/${view}`
			: entity && view
				? `/${view}/${entity.token}`
				: "";
	const branch = search.branch?.trim();
	const query = branch ? `?${new URLSearchParams({ branch })}` : "";
	return {
		links: [{ rel: "canonical", href: root + suffix + query }],
		...pageHead(
			`${repository}${detail ? ` · ${detail}` : ""} — LixRay`,
			`${detail ? `${detail} in` : "Explore"} ${repository} on LixRay.`,
		),
	};
}
