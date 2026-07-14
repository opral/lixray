import assert from "node:assert/strict";
import test from "node:test";
import {
	isAtelierFileNotFoundError,
	isLixBranchNotFoundError,
	resolveAtelierRouteBranchId,
	shouldNormalizeInitialBranch,
} from "../lib/atelier-navigation.ts";
import { MockRemoteLixError } from "../lib/mock-remote-lix.ts";

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

void test("only typed branch-not-found failures qualify for URL fallback", () => {
	assert.equal(
		isLixBranchNotFoundError(
			new MockRemoteLixError("LIX_BRANCH_NOT_FOUND", "missing"),
		),
		true,
	);
	assert.equal(
		isLixBranchNotFoundError(
			new MockRemoteLixError("LIX_UNAUTHORIZED", "expired"),
		),
		false,
	);
	assert.equal(
		isLixBranchNotFoundError(
			Object.assign(new Error("missing"), { code: "LIX_BRANCH_NOT_FOUND" }),
		),
		false,
		"an unrelated coded error cannot trigger destructive URL normalization",
	);
});

void test("initial branch normalization never overwrites a newer route", () => {
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "branch-a",
			currentBranchId: "branch-b",
			actualBranchId: "branch-a",
		}),
		false,
	);
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "branch-a",
			currentBranchId: null,
			actualBranchId: "branch-a",
		}),
		false,
		"a branchless route reached while initialization is pending remains authoritative",
	);
	assert.equal(
		shouldNormalizeInitialBranch({
			openingBranchId: "missing",
			currentBranchId: "missing",
			actualBranchId: "main",
		}),
		true,
	);
});

void test("a branch-to-branchless route transition targets main without rewriting the URL", () => {
	assert.equal(resolveAtelierRouteBranchId("draft", "main"), "draft");
	assert.equal(resolveAtelierRouteBranchId(undefined, "main"), "main");
});
