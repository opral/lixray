import { openLix, type Lix } from "@lix-js/sdk";
import { lexer, walkTokens } from "marked";

type PublishedFile = { path: string; content: Uint8Array };
type PublishedReadOptions = {
	signal?: AbortSignal;
	/** Each asset passes the same server-side publication check as the document. */
	readAsset?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
};

export async function readPublishedFiles(
	file: PublishedFile,
	options: PublishedReadOptions = {},
): Promise<PublishedFile[]> {
	options.signal?.throwIfAborted();
	const files = [file];
	if (!options.readAsset) return files;
	for (const path of publishedAssetPaths(file)) {
		options.signal?.throwIfAborted();
		try {
			const content = await options.readAsset(path, options.signal);
			options.signal?.throwIfAborted();
			files.push({ path, content });
		} catch {
			options.signal?.throwIfAborted();
		}
	}
	return files;
}

/** A disposable projection of authorized bytes, never a private repository replica. */
export async function createPublishedLix(
	file: PublishedFile,
	options: PublishedReadOptions = {},
): Promise<{ lix: Lix; fileId: string }> {
	const files = await readPublishedFiles(file, options);
	options.signal?.throwIfAborted();
	const lix = await openLix();
	try {
		options.signal?.throwIfAborted();
		const result = await lix.execute(
			"INSERT INTO lix_file (path, content) VALUES ($1, $2) RETURNING id",
			[file.path, file.content],
		);
		const fileId = result.rows[0]?.id;
		if (typeof fileId !== "string")
			throw new Error("Unable to prepare published file.");
		for (const asset of files.slice(1)) {
			options.signal?.throwIfAborted();
			await lix.execute(
				"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
				[asset.path, asset.content],
			);
		}
		return { lix, fileId };
	} catch (error) {
		await lix.close();
		throw error;
	}
}

/** Discover embedded resources for the projection; rendering remains in Atelier. */
export function publishedAssetPaths(file: {
	path: string;
	content: Uint8Array;
}): string[] {
	if (!/\.(md|markdown)$/i.test(file.path)) return [];
	const paths = new Set<string>();
	const base = new URL(file.path, "https://publication.invalid");
	void walkTokens(lexer(new TextDecoder().decode(file.content)), (token) => {
		if (token.type !== "image" || typeof token.href !== "string") return;
		try {
			const url = new URL(token.href, base);
			if (url.origin !== base.origin) return;
			const segments: string[] = [];
			for (const segment of decodeURIComponent(url.pathname)
				.replaceAll("\\", "/")
				.split("/")) {
				if (!segment || segment === ".") continue;
				if (segment === "..") segments.pop();
				else segments.push(segment);
			}
			const path = `/${segments.join("/")}`;
			// Embedded media is data, never an extension installation request.
			if (path.startsWith("/.lix/app_data/atelier/extensions/")) return;
			if (path !== file.path) paths.add(path);
		} catch {
			/* Invalid escaped resource paths cannot be fetched. */
		}
	});
	return [...paths];
}
