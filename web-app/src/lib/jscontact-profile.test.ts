import assert from "node:assert/strict";
import test from "node:test";
import { jsContactAvatarUri } from "./jscontact-profile.ts";

void test("reads the preferred JSContact photo", () => {
	assert.equal(
		jsContactAvatarUri({
			"@type": "Card",
			version: "2.0",
			media: {
				other: {
					"@type": "Media",
					kind: "photo",
					uri: "https://example.com/other.png",
				},
				avatar: {
					"@type": "Media",
					kind: "photo",
					uri: "https://example.com/avatar.png",
				},
			},
		}),
		"https://example.com/avatar.png",
	);
});

void test("rejects non-card and unsafe avatar documents", () => {
	assert.equal(
		jsContactAvatarUri({
			"@type": "Card",
			media: { avatar: { kind: "photo", uri: "javascript:alert(1)" } },
		}),
		null,
	);
	assert.equal(
		jsContactAvatarUri({
			"@type": "NotACard",
			media: {
				avatar: { kind: "photo", uri: "https://example.com/avatar.png" },
			},
		}),
		null,
	);
});

void test("allows HTTP avatars only from the local development host", () => {
	assert.equal(
		jsContactAvatarUri({
			"@type": "Card",
			version: "2.0",
			media: {
				avatar: {
					kind: "photo",
					uri: "http://127.0.0.1:8787/demo-profile-avatar.svg",
				},
			},
		}),
		"http://127.0.0.1:8787/demo-profile-avatar.svg",
	);
	assert.equal(
		jsContactAvatarUri({
			"@type": "Card",
			version: "2.0",
			media: {
				avatar: {
					kind: "photo",
					uri: "http://example.com/avatar.png",
				},
			},
		}),
		null,
	);
});
