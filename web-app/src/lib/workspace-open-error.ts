const UNSUPPORTED_STORAGE_PROTOCOL_MESSAGE =
	"unsupported live-state hot-index storage protocol";

export function formatWorkspaceOpenError(caught: unknown): string {
	const message = getErrorMessage(caught);

	if (message.includes(UNSUPPORTED_STORAGE_PROTOCOL_MESSAGE)) {
		return "This workspace was created with an older Lix storage format that this version can no longer read. Automatic migration is unavailable. Recreate the workspace to continue; its existing files and history can only be recovered from an export or backup.";
	}

	return message;
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
