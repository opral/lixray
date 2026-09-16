export interface ProfileRepositoryActivity {
	id: string;
	name: string;
	slug: string;
	namespaceHandle: string;
	fileCount: number | null;
}

export interface ProfileFileMixSegment {
	label: string;
	examples: string;
	count: number;
	percentage: number;
	color: string;
}

export interface PublicProfileActivity {
	totalFiles: number;
	repositories: Array<ProfileRepositoryActivity>;
	fileMix: Array<ProfileFileMixSegment>;
	failedRepositories: number;
	/** When the server computed these numbers; cached responses keep the original stamp. */
	computedAt?: string;
}

export interface ProfileRepositorySource {
	id: string;
	name: string;
	slug: string;
	namespaceHandle: string;
}

export interface ProfileRepositoryFiles {
	repository: ProfileRepositorySource;
	paths: Array<string> | null;
}

const FILE_CATEGORIES = [
	{
		label: "Docs",
		examples: "markdown, text",
		color: "color-mix(in srgb, var(--atelier-tag-brown-fg) 48%, var(--atelier-panel))",
		extensions: new Set([
			"adoc",
			"doc",
			"docx",
			"markdown",
			"md",
			"mdx",
			"odt",
			"rst",
			"rtf",
			"txt",
		]),
	},
	{
		label: "Code",
		examples: "ts, rust",
		color: "color-mix(in srgb, var(--atelier-tag-brown-fg) 36%, var(--atelier-panel))",
		extensions: new Set([
			"c",
			"cc",
			"cpp",
			"cs",
			"css",
			"go",
			"graphql",
			"h",
			"hpp",
			"html",
			"java",
			"js",
			"json",
			"jsx",
			"kt",
			"php",
			"proto",
			"py",
			"rb",
			"rs",
			"scss",
			"sh",
			"sql",
			"svelte",
			"swift",
			"toml",
			"ts",
			"tsx",
			"vue",
			"xml",
			"yaml",
			"yml",
		]),
	},
	{
		label: "Sheets",
		examples: "csv, tables",
		color: "color-mix(in srgb, var(--atelier-tag-brown-fg) 26%, var(--atelier-panel))",
		extensions: new Set(["csv", "numbers", "ods", "tsv", "xls", "xlsx"]),
	},
	{
		label: "Decks",
		examples: "slides",
		color: "color-mix(in srgb, var(--atelier-tag-brown-fg) 17%, var(--atelier-panel))",
		extensions: new Set(["key", "odp", "ppt", "pptx"]),
	},
	{
		label: "PDFs & other",
		examples: "pdf, images",
		color: "color-mix(in srgb, var(--atelier-tag-brown-fg) 10%, var(--atelier-panel))",
		extensions: null,
	},
] as const;

export function aggregatePublicProfileActivity(
	inputs: Array<ProfileRepositoryFiles>,
): PublicProfileActivity {
	const counts = FILE_CATEGORIES.map(() => 0);
	let totalFiles = 0;
	let failedRepositories = 0;

	const repositories = inputs.map(({ repository, paths }) => {
		if (paths === null) failedRepositories += 1;
		else {
			totalFiles += paths.length;
			for (const path of paths) counts[fileCategoryIndex(path)] += 1;
		}
		return { ...repository, fileCount: paths?.length ?? null };
	});
	const percentages = integerPercentages(counts, totalFiles);

	return {
		totalFiles,
		repositories,
		fileMix: FILE_CATEGORIES.map((category, index) => ({
			label: category.label,
			examples: category.examples,
			count: counts[index],
			percentage: percentages[index],
			color: category.color,
		})),
		failedRepositories,
	};
}

function fileCategoryIndex(path: string): number {
	const filename = path.split("/").pop() ?? path;
	const extension = filename.includes(".")
		? (filename.split(".").pop()?.toLowerCase() ?? "")
		: "";
	const index = FILE_CATEGORIES.findIndex(
		(category) => category.extensions?.has(extension) === true,
	);
	return index === -1 ? FILE_CATEGORIES.length - 1 : index;
}

function integerPercentages(
	counts: Array<number>,
	total: number,
): Array<number> {
	if (total === 0) return counts.map(() => 0);
	const exact = counts.map((count) => (count / total) * 100);
	const roundedDown = exact.map(Math.floor);
	let remainder = 100 - roundedDown.reduce((sum, value) => sum + value, 0);
	const byFraction = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((left, right) => right.fraction - left.fraction);
	for (const { index } of byFraction) {
		if (remainder === 0) break;
		roundedDown[index] += 1;
		remainder -= 1;
	}
	return roundedDown;
}
