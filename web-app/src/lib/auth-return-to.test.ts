import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAuthReturnTo } from "./auth-return-to.ts";

void test("accepts same-origin app paths", () => {
	assert.equal(normalizeAuthReturnTo("/open"), "/open");
	assert.equal(normalizeAuthReturnTo("/home"), "/home");
	assert.equal(
		normalizeAuthReturnTo("/@acme/launch-q3?invite=token#continue"),
		"/@acme/launch-q3?invite=token#continue",
	);
});

void test("rejects external auth return targets", () => {
	for (const value of [
		"https://evil.example",
		"//evil.example",
		"//[",
		"/\\evil.example",
		"/\\\\evil.example",
	]) {
		assert.equal(normalizeAuthReturnTo(value), "/", value);
	}
});
