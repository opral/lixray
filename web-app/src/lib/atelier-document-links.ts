import type { AtelierDocumentLinks } from "@opral/atelier";
import { atelierBranchSearch } from "./atelier-navigation.ts";
import { entityRouteBase, parseEntityUrlSplat } from "./entity-url.ts";

/** The origins whose file URLs name files of this deployment. */
const CANONICAL_ORIGIN = "https://lixray.com";

/**
 * LixRay's stored file URLs for Atelier: `https://lixray.com/@ns/slug/file/<id>`
 * (a `branch` parameter only off the default branch). A document may carry
 * one pasted from the browser or written by an agent; Atelier treats it like
 * a relative link when it names a file of the open repository on the branch
 * being viewed. Mentions insert the ID-only form, which survives renames.
 */
export function createAtelierDocumentLinks({
	origin,
	namespace,
	repository,
	activeBranchId,
	defaultBranchId,
}: {
	readonly origin: string;
	readonly namespace: string;
	readonly repository: string;
	readonly activeBranchId: () => string;
	readonly defaultBranchId: () => string;
}): AtelierDocumentLinks & {
	readonly href: NonNullable<AtelierDocumentLinks["href"]>;
} {
	const sameName = (left: string, right: string) =>
		left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
	return {
		resolve(href) {
			let url: URL;
			try {
				url = new URL(href);
			} catch {
				return null;
			}
			if (url.origin !== origin && url.origin !== CANONICAL_ORIGIN) return null;
			const match = /^\/@([^/]+)\/([^/]+)\/file\/(.+)$/.exec(url.pathname);
			if (!match) return null;
			let handle: string;
			let slug: string;
			try {
				handle = decodeURIComponent(match[1]!);
				slug = decodeURIComponent(match[2]!);
			} catch {
				return null;
			}
			// The splat stays as written: parseEntityUrlSplat decodes it, and
			// decoding twice would eat a percent that belongs to the name.
			const splat = match[3]!;
			if (!sameName(handle, namespace) || !sameName(slug, repository))
				return null;
			// A link into another branch is a navigation, not a tab.
			const branch = url.searchParams.get("branch") ?? defaultBranchId();
			if (branch !== activeBranchId()) return null;
			const entity = parseEntityUrlSplat(splat);
			return entity ? { id: entity.id } : null;
		},
		href(file) {
			const url = new URL(
				entityRouteBase(namespace, repository, "file", file.id),
				origin,
			);
			const { branch } = atelierBranchSearch(
				activeBranchId(),
				defaultBranchId(),
			);
			if (branch) url.searchParams.set("branch", branch);
			return url.href;
		},
	};
}
