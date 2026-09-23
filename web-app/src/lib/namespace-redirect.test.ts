import assert from "node:assert/strict";
import test from "node:test";
import { canonicalNamespaceHref } from "./namespace-redirect.ts";

void test("redirects a profile to the canonical handle", () => {
	assert.equal(
		canonicalNamespaceHref(
			"https://lixray.com/@old-name?tab=files#recent",
			"old-name",
			"new-name",
		),
		"https://lixray.com/@new-name?tab=files#recent",
	);
});

void test("preserves repository deep links and branch selection", () => {
	assert.equal(
		canonicalNamespaceHref(
			"https://lixray.com/@old-name/project/file/abc/readme.md?branch=dev#L4",
			"old-name",
			"new-name",
		),
		"https://lixray.com/@new-name/project/file/abc/readme.md?branch=dev#L4",
	);
});

void test("does not rewrite another namespace or an already canonical URL", () => {
	assert.equal(
		canonicalNamespaceHref(
			"https://lixray.com/@old-name-extra/project",
			"old-name",
			"new-name",
		),
		null,
	);
	assert.equal(
		canonicalNamespaceHref(
			"https://lixray.com/@new-name/project",
			"new-name",
			"new-name",
		),
		null,
	);
});
