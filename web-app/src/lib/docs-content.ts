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

export const legalPages = {
	privacy: { path: "privacy.md", label: "Privacy Policy", slug: "privacy" },
	support: { path: "support.md", label: "Support", slug: "support" },
	terms: { path: "terms.md", label: "Terms of Service", slug: "terms" },
} as const;

export type LegalSlug = keyof typeof legalPages;

export function legalMarkdown(slug: LegalSlug): string {
	const path = legalPages[slug].path;
	const raw = markdownByPath[path];
	if (raw === undefined) {
		throw new Error(`legal page "${path}" is missing from docs/`);
	}
	return raw;
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
