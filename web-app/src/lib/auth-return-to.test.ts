import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAuthReturnTo } from "./auth-return-to.ts";

void test("accepts same-origin app paths", () => {
	assert.equal(normalizeAuthReturnTo("/open"), "/open");
	assert.equal(normalizeAuthReturnTo("/?app=1"), "/?app=1");
	assert.equal(
		normalizeAuthReturnTo("/invite/token?source=pwa#continue"),
		"/invite/token?source=pwa#continue",
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
