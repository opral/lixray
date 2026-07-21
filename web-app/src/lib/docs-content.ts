import tableOfContent from "../../../docs/table_of_content.json";

export interface DocsEntry {
	/** File name inside docs/, e.g. "url-schema.md" — the TOC's source of truth. */
	path: string;
	label: string;
	group: string;
	/** URL slug under /docs, e.g. "url-schema". */
	slug: string;
}

const markdownByPath = Object.fromEntries(
	Object.entries(
		import.meta.glob("../../../docs/*.md", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	).map(([importPath, raw]) => [importPath.split("/").pop() ?? "", raw]),
);

export const docsToc: Record<string, { path: string; label: string }[]> =
	tableOfContent;

export const docsEntries: DocsEntry[] = Object.entries(docsToc).flatMap(
	([group, items]) =>
		items.map((item) => ({
			...item,
			group,
			slug: item.path.replace(/\.md$/, ""),
		})),
);

export function docsEntryBySlug(slug: string): DocsEntry | undefined {
	return docsEntries.find((entry) => entry.slug === slug);
}

export function docsMarkdown(entry: DocsEntry): string {
	const raw = markdownByPath[entry.path];
	if (raw === undefined) {
		throw new Error(
			`docs/table_of_content.json lists "${entry.path}" but docs/ has no such file`,
		);
	}
	return raw;
}
