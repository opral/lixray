const UNSUPPORTED_STORAGE_PROTOCOL_MESSAGE =
	"unsupported live-state hot-index storage protocol";
const UNSUPPORTED_STORAGE_FORMAT_CODES = new Set([
	"LIX_ERROR_UNSUPPORTED_STORAGE_FORMAT",
	"LIX_ERROR_STORAGE_FORMAT_UNSUPPORTED",
]);

export function formatWorkspaceOpenError(caught: unknown): string {
	const message = getErrorMessage(caught);
	const code = getErrorCode(caught);

	if (
		(code && UNSUPPORTED_STORAGE_FORMAT_CODES.has(code)) ||
		message.includes(UNSUPPORTED_STORAGE_PROTOCOL_MESSAGE)
	) {
		return "This workspace was created with an older Lix storage format that this version can no longer read. Automatic migration is unavailable. Recreate the workspace to continue; its existing files and history can only be recovered from an export or backup.";
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
