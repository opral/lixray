import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRepositoryOpenError } from "./repository-open-error.ts";

void test("preserves the engine's unsupported repository protocol error", () => {
	assert.equal(
		formatRepositoryOpenError(
			new Error(
				"repository uses an unsupported live-state hot-index storage protocol; recreate the repository",
			),
		),
		"repository uses an unsupported live-state hot-index storage protocol; recreate the repository",
	);
});

void test("preserves the engine's structured unsupported format error", () => {
	const error = Object.assign(
		new Error("This lix uses an unsupported storage format."),
		{ code: "LIX_ERROR_UNSUPPORTED_STORAGE_FORMAT" },
	);

	assert.equal(
		formatRepositoryOpenError(error),
		"This lix uses an unsupported storage format.",
	);
});

void test("preserves unrelated repository opening errors", () => {
	assert.equal(
		formatRepositoryOpenError(
			new Error("A repository access token is required."),
		),
		"A repository access token is required.",
	);
});

void test("explains a terminal automatic migration failure", () => {
	for (const code of [
		"LIX_ERROR_MIGRATION_FAILED",
		"LIX_ERROR_MIGRATION_FAILED",
		"LIX_ERROR_REPOSITORY_UPGRADE",
	]) {
		assert.equal(
			formatRepositoryOpenError(
				Object.assign(new Error("The lix repository migration failed."), {
					code,
				}),
			),
			`Repository migration failed (${code}): The lix repository migration failed.`,
		);
	}
});

void test("preserves migration details from serialized engine errors", () => {
	const message =
		"copy target write failed: precondition failed: [PreconditionFailure { index: 1 }]";
	assert.equal(
		formatRepositoryOpenError({ code: "LIX_ERROR_MIGRATION_FAILED", message }),
		`Repository migration failed (LIX_ERROR_MIGRATION_FAILED): ${message}`,
	);
});
