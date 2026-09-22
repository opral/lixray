export function isRepositoryStorageInUse(caught: unknown): boolean {
	return getErrorCode(caught) === "LIX_STORAGE_IN_USE";
}

export function formatRepositoryOpenError(caught: unknown): string {
	const message = getErrorMessage(caught);
	const code = getErrorCode(caught);

	if (
		code === "LIX_ERROR_MIGRATION_FAILED" ||
		code === "LIX_ERROR_REPOSITORY_UPGRADE"
	) {
		return `Repository migration failed (${code}): ${message}`;
	}

	if (code === "LIX_OWNER_VERSION_MISMATCH") {
		return "Another tab is running a different Lix version. Save any unsaved edits, close all other lixray.com tabs and app windows, then retry. Your saved repository data remains in this browser.";
	}

	return message;
}

function getErrorCode(caught: unknown): string | undefined {
	if (caught && typeof caught === "object" && "code" in caught) {
		const code = (caught as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}

	return undefined;
}

function getErrorMessage(caught: unknown): string {
	if (
		caught &&
		typeof caught === "object" &&
		"message" in caught &&
		typeof caught.message === "string" &&
		caught.message.trim()
	) {
		return caught.message;
	}
	if (caught instanceof Error) {
		return caught.message;
	}
	if (typeof caught === "string") {
		return caught;
	}
	if (caught === null || caught === undefined) {
		return "Unexpected error";
	}

	try {
		return JSON.stringify(caught) ?? "Unexpected error";
	} catch {
		return "Unexpected error";
	}
}
