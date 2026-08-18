import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryListError } from "./repository-list-error.ts";
import {
	AUTH_CALLBACK_PATH,
	isTransientRepositoryListFailure,
	shouldCaptureRepositoryListException,
	shouldRefreshRepositoryList,
} from "./repository-list-refresh.ts";

void test("skips repository list refresh on the OAuth callback", () => {
	assert.equal(shouldRefreshRepositoryList(AUTH_CALLBACK_PATH), false);
	assert.equal(shouldRefreshRepositoryList("/@opral/monorepo"), true);
	assert.equal(shouldRefreshRepositoryList("/home"), true);
});

void test("does not alert RepositoryListError during the auth callback happy path", () => {
	const failure = new RepositoryListError("bootstrap_personal_namespace", {
		status: 0,
		error: { message: "Failed to fetch" },
	});

	assert.equal(isTransientRepositoryListFailure(failure), true);
	assert.equal(
		shouldCaptureRepositoryListException(AUTH_CALLBACK_PATH, failure),
		false,
	);
	assert.equal(
		shouldCaptureRepositoryListException("/@opral/monorepo", failure),
		false,
	);
});

void test("does not alert an aborted repository list request", () => {
	const aborted = Object.assign(new Error("The operation was aborted."), {
		name: "AbortError",
	});

	assert.equal(
		shouldCaptureRepositoryListException(
			"/home",
			new RepositoryListError("repository_refresh", { error: aborted }),
			aborted,
		),
		false,
	);
});

void test("still alerts a real repository list failure after sign-in lands", () => {
	const failure = new RepositoryListError("list_accessible_lixes", {
		status: 500,
		error: { code: "P0001" },
	});

	assert.equal(isTransientRepositoryListFailure(failure), false);
	assert.equal(
		shouldCaptureRepositoryListException("/home", failure),
		true,
	);
});
