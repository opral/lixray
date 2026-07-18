import assert from "node:assert/strict";
import test from "node:test";
import {
	atelierBranchSearch,
	isAtelierFileNotFoundError,
	isLixBranchNotFoundError,
	resolveAtelierRouteBranchId,
	shouldNormalizeInitialBranch,
} from "../lib/atelier-navigation.ts";

void test("only the requested normalized Atelier not-found path redirects", () => {
	const requestedPath = "/notes/branch-only.md";

	assert.equal(
		isAtelierFileNotFoundError(
			new Error(`File not found in the opened workspace: ${requestedPath}`),
			requestedPath,
		),
		true,
	);
	assert.equal(
		isAtelierFileNotFoundError(
			new Error("Network request failed"),
			requestedPath,
		),
		false,
		"transient failures leave the current route in place",
	);
	assert.equal(
		isAtelierFileNotFoundError(
			new Error("File not found in the opened workspace: /notes/other.md"),
			requestedPath,
		),
		false,
	);
	assert.equal(
		isAtelierFileNotFoundError(
			new Error("File not found in the opened workspace: /notes/missing.md"),
			"/notes//draft/../missing.md",
		),
		true,
		"Atelier normalizes the path before reporting a missing file",
	);
});

void test("only Lix branch-not-found errors qualify for URL fallback", () => {
	assert.equal(
		isLixBranchNotFoundError(
			Object.assign(new Error("missing"), { code: "LIX_BRANCH_NOT_FOUND" }),
		),
		true,
	);
	assert.equal(
		isLixBranchNotFoundError(
			Object.assign(new Error("expired"), { code: "LIX_UNAUTHORIZED" }),
		),
		false,
	);
	assert.equal(
		isLixBranchNotFoundError({ code: "LIX_BRANCH_NOT_FOUND" }),
		false,
		"an unthrown response body cannot trigger URL normalization",
	);
});

void test("initial branch normalization never overwrites a newer route", () => {
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "branch-a",
			currentBranchId: "branch-b",
			actualBranchId: "branch-a",
			defaultBranchId: "main",
		}),
		false,
	);
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "branch-a",
			currentBranchId: null,
			actualBranchId: "branch-a",
			defaultBranchId: "main",
		}),
		false,
		"a branchless route reached while initialization is pending remains authoritative",
	);
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "missing",
			currentBranchId: "missing",
			actualBranchId: "main",
			defaultBranchId: "main",
		}),
		true,
	);
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "main",
			currentBranchId: "main",
			actualBranchId: "main",
			defaultBranchId: "main",
		}),
		true,
		"an explicit current branch is canonicalized to a branchless URL",
	);
});

void test("a branch-to-branchless route transition targets the default without rewriting the URL", () => {
	assert.equal(resolveAtelierRouteBranchId("draft", "main"), "draft");
	assert.equal(resolveAtelierRouteBranchId(undefined, "main"), "main");
	assert.deepEqual(atelierBranchSearch("main", "main"), {});
	assert.deepEqual(atelierBranchSearch("draft", "main"), { branch: "draft" });
});
