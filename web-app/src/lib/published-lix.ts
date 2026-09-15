import { openLix, type Lix } from "@lix-js/sdk";
import { lexer, walkTokens } from "marked";
import { publishedResponseError } from "./published-error.ts";
export { publishedResponseError } from "./published-error.ts";
import { resolvePublishedEntity } from "./entity-url.ts";

export type PublishedLixOptions = {
	origin: string;
	repositoryId: string;
	namespace: string;
	repositorySlug: string;
	fileId: string;
	path: string;
	signal?: AbortSignal;
};

/** Populate a disposable local Lix with independently authorized downloads. */
export async function openPublishedLix(
	options: PublishedLixOptions,
): Promise<Lix> {
	options.signal?.throwIfAborted();
	const download = async (id: string, path: string) => {
		const url = new URL(
			`/api/published/lix/${options.repositoryId}/file`,
			options.origin,
		);
		url.searchParams.set("id", id);
		url.searchParams.set("path", path);
		const response = await fetch(url, {
			credentials: "omit",
			signal: options.signal,
		});
		if (!response.ok) throw new Error(await publishedResponseError(response));
		return new Uint8Array(await response.arrayBuffer());
	};
	const content = await download(options.fileId, options.path);
	options.signal?.throwIfAborted();
	const lix = await openLix();
	try {
		const insert = async (id: string, path: string, bytes: Uint8Array) => {
			options.signal?.throwIfAborted();
			await lix.execute(
				"INSERT INTO lix_file (id, path, content) VALUES ($1, $2, $3)",
				[id, path, bytes],
			);
		};
		await insert(options.fileId, options.path, content);
		for (const path of publishedAssetPaths({ path: options.path, content })) {
			options.signal?.throwIfAborted();
			const entity = await resolvePublishedEntity({
				namespace: options.namespace,
				repository: options.repositorySlug,
				kind: "file",
				path,
				signal: options.signal,
			});
			if (entity?.lixId !== options.repositoryId) continue;
			await insert(
				entity.id,
				entity.path,
				await download(entity.id, entity.path),
			);
		}
		options.signal?.throwIfAborted();
		return lix;
	} catch (error) {
		await lix.close().catch(() => undefined);
		throw error;
	}
}

/** Discover embedded resources for the local view; rendering remains in Atelier. */
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
