const FILE_NOT_FOUND_PREFIX = "File not found in the opened repository: ";

export function isAtelierFileNotFoundError(
	error: unknown,
	requestedPath: string,
): boolean {
	if (
		!(error instanceof Error) ||
		!error.message.startsWith(FILE_NOT_FOUND_PREFIX)
	) {
		return false;
	}
	const missingPath = error.message.slice(FILE_NOT_FOUND_PREFIX.length);
	const normalizedMissingPath = normalizeAtelierFilePath(missingPath);
	return (
		normalizedMissingPath !== null &&
		normalizedMissingPath === normalizeAtelierFilePath(requestedPath)
	);
}

export function isLixBranchNotFoundError(
	error: unknown,
): error is Error & { code: "LIX_BRANCH_NOT_FOUND" } {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "LIX_BRANCH_NOT_FOUND"
	);
}

export function shouldNormalizeInitialBranch(args: {
	readonly openingBranchId: string | null;
	readonly currentBranchId: string | null;
	readonly actualBranchId: string;
	readonly defaultBranchId: string;
}): boolean {
	return (
		args.currentBranchId === args.openingBranchId &&
		(args.currentBranchId !== args.actualBranchId ||
			(args.currentBranchId !== null &&
				args.currentBranchId === args.defaultBranchId))
	);
}

export function atelierBranchSearch(
	branchId: string,
	defaultBranchId: string,
): { branch?: string } {
	return branchId === defaultBranchId ? {} : { branch: branchId };
}

export function resolveAtelierRouteBranchId(
	branchId: string | undefined,
	defaultBranchId: string,
): string {
	return branchId ?? defaultBranchId;
}

function normalizeAtelierFilePath(filePath: string): string | null {
	if (!filePath) return null;
	const rootedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
	const segments: string[] = [];
	for (const segment of rootedPath.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length > 0 ? `/${segments.join("/")}` : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The words a conversation URL's slug is made from: its title, else what it
 * is attached to (Atelier's `anchorLabel`), else "Conversation" — the same
 * name the conversation's tab shows.
 */
/** What names a conversation: the part of Atelier's `ConversationSummary` a URL reads. */
export type ConversationNameParts = {
	readonly title: string | null;
	readonly anchorLabel: string | null;
};

export function conversationSlugText(summary: ConversationNameParts): string {
	return summary.title ?? summary.anchorLabel ?? "Conversation";
}

/**
 * The conversation an active `atelier_conversation` view names, from its
 * `main_view_activated` state. `slugText` is null until the view has read
 * the conversation and labelled its tab; a later event for the same view
 * carries it.
 */
export function conversationFromViewState(state: unknown): {
	readonly conversationId: string;
	readonly slugText: string | null;
} | null {
	if (!state || typeof state !== "object") return null;
	const { conversationId, title, atelier } = state as {
		conversationId?: unknown;
		title?: unknown;
		atelier?: unknown;
	};
	if (typeof conversationId !== "string" || !UUID.test(conversationId))
		return null;
	const label =
		atelier && typeof atelier === "object"
			? (atelier as { label?: unknown }).label
			: undefined;
	const slugText =
		typeof title === "string" && title.trim()
			? title
			: typeof label === "string" && label.trim()
				? label
				: null;
	return { conversationId: conversationId.toLowerCase(), slugText };
}
