import { RepositoryListError } from "./repository-list-error.ts";

export const AUTH_CALLBACK_PATH = "/auth/callback";

export function shouldRefreshRepositoryList(pathname: string): boolean {
	return pathname !== AUTH_CALLBACK_PATH;
}

export function isTransientRepositoryListFailure(error: unknown): boolean {
	if (isAbortLikeError(error)) return true;
	if (error instanceof RepositoryListError && error.httpStatus === 0) {
		return true;
	}
	if (error && typeof error === "object" && "status" in error) {
		return (error as { status?: unknown }).status === 0;
	}
	return false;
}

export function shouldCaptureRepositoryListException(
	pathname: string,
	error: unknown,
	rawError: unknown = error,
): boolean {
	if (!shouldRefreshRepositoryList(pathname)) return false;
	return (
		!isTransientRepositoryListFailure(error) &&
		!isTransientRepositoryListFailure(rawError)
	);
}

function isAbortLikeError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { name?: unknown; message?: unknown };
	if (candidate.name === "AbortError") return true;
	if (error instanceof Error && /aborted|failed to fetch/i.test(error.message)) {
		return true;
	}
	return false;
}
