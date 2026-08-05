import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkspaceOpenError } from "./workspace-open-error.ts";

void test("explains how to recover from an unsupported repository protocol", () => {
	assert.equal(
		formatWorkspaceOpenError(
			new Error(
				"repository uses an unsupported live-state hot-index storage protocol; recreate the repository",
			),
		),
		"This workspace was created with an older Lix storage format that this version can no longer read. Automatic migration is unavailable. Recreate the workspace to continue; its existing files and history can only be recovered from an export or backup.",
	);
});

void test("explains how to recover from the structured unsupported format error", () => {
	const error = Object.assign(
		new Error("This lix uses an unsupported storage format."),
		{ code: "LIX_ERROR_STORAGE_FORMAT_UNSUPPORTED" },
	);

	assert.equal(
		formatWorkspaceOpenError(error),
		"This workspace was created with an older Lix storage format that this version can no longer read. Automatic migration is unavailable. Recreate the workspace to continue; its existing files and history can only be recovered from an export or backup.",
	);
});

void test("preserves unrelated workspace opening errors", () => {
	assert.equal(
		formatWorkspaceOpenError(
			new Error("A repository access token is required."),
		),
		"A repository access token is required.",
	);
});
