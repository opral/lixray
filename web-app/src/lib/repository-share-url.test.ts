import assert from "node:assert/strict";
import test from "node:test";
import {
	appendRepositoryShareToken,
	stripInviteFromUrl,
} from "./repository-share-url.ts";

void test("share URLs add the capability without changing the canonical path", () => {
	const canonical =
		"https://lixray.com/@acme/launch-q3/file/icp.md?branch=main#notes";
	assert.equal(
		appendRepositoryShareToken(canonical, "opaque_token"),
		"https://lixray.com/@acme/launch-q3/file/icp.md?branch=main&invite=opaque_token#notes",
	);
});

void test("canonicalization removes only the invite query parameter", () => {
	assert.equal(
		stripInviteFromUrl(
			"https://lixray.com/@acme/launch-q3/file/icp.md?branch=main&invite=opaque_token&pin=42#notes",
		),
		"https://lixray.com/@acme/launch-q3/file/icp.md?branch=main&pin=42#notes",
	);
	assert.equal(
		stripInviteFromUrl("/file/icp.md?invite=opaque_token"),
		"/file/icp.md",
	);
});
