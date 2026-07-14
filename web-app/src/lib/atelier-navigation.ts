import { MockRemoteLixError } from "./mock-remote-lix.ts";

const FILE_NOT_FOUND_PREFIX = "File not found in the opened workspace: ";

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
): error is MockRemoteLixError {
	return (
		error instanceof MockRemoteLixError && error.code === "LIX_BRANCH_NOT_FOUND"
	);
}

export function shouldNormalizeInitialBranch(args: {
	readonly openingBranchId: string | null;
	readonly currentBranchId: string | null;
	readonly actualBranchId: string;
}): boolean {
	return (
		args.currentBranchId === args.openingBranchId &&
		args.currentBranchId !== args.actualBranchId
	);
}

export function resolveAtelierRouteBranchId(
	branchId: string | undefined,
	mainBranchId: string,
): string {
	return branchId ?? mainBranchId;
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
