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

export interface ProfileRepositoryFileCounts {
	repository: ProfileRepositorySource;
	totalFiles: number | null;
	categoryCounts: Array<number> | null;
}

/** One-row exact aggregate; SQL categories are derived from FILE_CATEGORIES. */
export function publicProfileActivityAggregateSql(): string {
	const namedCategories = FILE_CATEGORIES.slice(0, -1);
	const inList = (values: Array<string>) =>
		values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
	const categories = namedCategories
		.map(
			(category, index) =>
				`    WHEN extension IN (${inList([...(category.extensions ?? [])].sort())}) THEN ${index}`,
		)
		.join("\n");
	const counts = FILE_CATEGORIES.map(
		(_, index) =>
			`  count(CASE WHEN category = ${index} THEN 1 END) AS category_${index}`,
	).join(",\n");
	return `WITH file_names AS (\n  SELECT split_part(path, '/', -1) AS base FROM lix_file\n),\nfile_extensions AS (\n  SELECT CASE WHEN strpos(base, '.') = 0 THEN '' ELSE lower(split_part(base, '.', -1)) END AS extension\n  FROM file_names\n),\nfile_categories AS (\n  SELECT CASE\n${categories}\n    ELSE ${FILE_CATEGORIES.length - 1}\n  END AS category\n  FROM file_extensions\n)\nSELECT\n  count(*) AS total_files,\n${counts}\nFROM file_categories`;
}

const FILE_CATEGORIES = [
	{
		label: "Docs",
		examples: "markdown, text",
		color:
			"color-mix(in srgb, var(--atelier-tag-brown-fg) 48%, var(--atelier-panel))",
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
		color:
			"color-mix(in srgb, var(--atelier-tag-brown-fg) 36%, var(--atelier-panel))",
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
		color:
			"color-mix(in srgb, var(--atelier-tag-brown-fg) 26%, var(--atelier-panel))",
		extensions: new Set(["csv", "numbers", "ods", "tsv", "xls", "xlsx"]),
	},
	{
		label: "Decks",
		examples: "slides",
		color:
			"color-mix(in srgb, var(--atelier-tag-brown-fg) 17%, var(--atelier-panel))",
		extensions: new Set(["key", "odp", "ppt", "pptx"]),
	},
	{
		label: "PDFs & other",
		examples: "pdf, images",
		color:
			"color-mix(in srgb, var(--atelier-tag-brown-fg) 10%, var(--atelier-panel))",
		extensions: null,
	},
] as const;

export const PUBLIC_PROFILE_ACTIVITY_CATEGORY_COUNT = FILE_CATEGORIES.length;

export function aggregatePublicProfileActivityFromCounts(
	inputs: Array<ProfileRepositoryFileCounts>,
): PublicProfileActivity {
	const counts = FILE_CATEGORIES.map(() => 0);
	let totalFiles = 0;
	let failedRepositories = 0;
	const repositories = inputs.map(
		({ repository, totalFiles: fileCount, categoryCounts }) => {
			if (
				fileCount === null ||
				categoryCounts === null ||
				!Number.isSafeInteger(fileCount) ||
				fileCount < 0 ||
				categoryCounts.length !== FILE_CATEGORIES.length ||
				categoryCounts.some(
					(count) => !Number.isSafeInteger(count) || count < 0,
				) ||
				categoryCounts.reduce((sum, count) => sum + BigInt(count), 0n) !==
					BigInt(fileCount)
			) {
				failedRepositories += 1;
				return { ...repository, fileCount: null };
			}
			const nextTotal = totalFiles + fileCount;
			const overflows =
				!Number.isSafeInteger(nextTotal) ||
				counts.some(
					(count, index) =>
						!Number.isSafeInteger(count + categoryCounts[index]!),
				);
			if (overflows) {
				failedRepositories += 1;
				return { ...repository, fileCount: null };
			}
			totalFiles = nextTotal;
			for (let index = 0; index < counts.length; index++) {
				counts[index] += categoryCounts[index]!;
			}
			return { ...repository, fileCount };
		},
	);
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
