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
