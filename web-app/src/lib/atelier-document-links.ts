import type { AtelierDocumentLinks, AtelierNavigation } from "@opral/atelier";
import type { ATELIER_CONVERSATION_VIEW_ID } from "./atelier-conversation.ts";
import {
	atelierBranchSearch,
	conversationFromViewState,
} from "./atelier-navigation.ts";
import {
	conversationRouteBase,
	entityRouteBase,
	parseEntityUrlSplat,
} from "./entity-url.ts";

/** Checked against Atelier's export; a value import would load Atelier. */
const CONVERSATION_VIEW_ID: typeof ATELIER_CONVERSATION_VIEW_ID =
	"atelier_conversation";

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

/**
 * Atelier's `navigation.href`: the URL a view location has in LixRay, so
 * Atelier can render real links (History's and a document's "Open
 * conversation"), which open in a new browser tab or copy like any link.
 * A plain click still stays in the app: Atelier opens the tab and the
 * activation drives the URL.
 *
 * Only conversations are addressed by view location. Files resolve by id,
 * which a path location does not carry, so every other location falls back
 * to the repository; Atelier asks for those only when `fileHref` is set,
 * which LixRay does not provide.
 */
export function createAtelierNavigation({
	namespace,
	repository,
	activeBranchId,
	defaultBranchId,
}: {
	readonly namespace: string;
	readonly repository: string;
	readonly activeBranchId: () => string;
	readonly defaultBranchId: () => string;
}): AtelierNavigation {
	return {
		href(location) {
			const { branch } = atelierBranchSearch(
				location.branchId ?? activeBranchId(),
				defaultBranchId(),
			);
			const query = branch ? `?${new URLSearchParams({ branch })}` : "";
			const conversation =
				"view" in location && location.view === CONVERSATION_VIEW_ID
					? conversationFromViewState(location.state)
					: null;
			return conversation
				? `${conversationRouteBase(namespace, repository, conversation.conversationId)}${query}`
				: `/@${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}${query}`;
		},
	};
}
