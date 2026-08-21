import assert from "node:assert/strict";
import test from "node:test";
import {
	demoProfileDocumentWithOverride,
	editableProfileFromDocument,
	profileDocumentWithEdits,
	saveDemoProfileDocument,
} from "./profile-editor.ts";

const sourceDocument = {
	"@type": "Card",
	version: "2.0",
	kind: "individual",
	name: { full: "Samuel", pronunciation: "sam-yool" },
	notes: {
		bio: { note: "Old bio", custom: true },
		privateShapeButPublicData: { note: "Preserve this sibling" },
	},
	organizations: { opral: { name: "Opral", custom: "kept" } },
	titles: {
		founder: { kind: "title", name: "Founder", organizationId: "opral" },
	},
	addresses: { berlin: { full: "Berlin", countryCode: "DE" } },
	media: {
		avatar: {
			"@type": "Media",
			kind: "photo",
			uri: "https://example.com/old.png",
			custom: "kept",
		},
		banner: { kind: "photo", uri: "https://example.com/banner.png" },
	},
	links: {
		website: {
			uri: "https://example.com/",
			label: "Website",
			custom: "kept",
		},
	},
	customTopLevel: { preserved: true },
};

void test("reads the fields rendered by the public profile", () => {
	assert.deepEqual(editableProfileFromDocument(sourceDocument), {
		name: "Samuel",
		bio: "Old bio",
		title: "Founder",
		organization: "Opral",
		location: "Berlin",
		avatarUri: "https://example.com/old.png",
		links: [{ key: "website", label: "Website", uri: "https://example.com/" }],
	});
});

void test("merges edits without discarding unknown JSContact data", () => {
	const updated = profileDocumentWithEdits(sourceDocument, {
		name: "Samuel Stroschein",
		bio: "New bio",
		title: "Builder",
		organization: "Lix",
		location: "New York",
		avatarUri: "https://example.com/new.png",
		links: [
			{
				key: "website",
				label: "Home",
				uri: "https://samuel.example/path",
			},
		],
	});

	assert.deepEqual(updated.customTopLevel, { preserved: true });
	assert.equal(
		(updated.name as Record<string, unknown>).pronunciation,
		"sam-yool",
	);
	assert.deepEqual(
		(updated.notes as Record<string, unknown>).privateShapeButPublicData,
		{ note: "Preserve this sibling" },
	);
	assert.equal(
		(
			(updated.organizations as Record<string, unknown>).opral as Record<
				string,
				unknown
			>
		).custom,
		"kept",
	);
	assert.equal(
		(
			(updated.titles as Record<string, unknown>).founder as Record<
				string,
				unknown
			>
		).organizationId,
		"opral",
	);
	assert.deepEqual(
		(updated.media as Record<string, unknown>).banner,
		sourceDocument.media.banner,
	);
	assert.equal(
		(
			(updated.links as Record<string, unknown>).website as Record<
				string,
				unknown
			>
		).custom,
		"kept",
	);
});

void test("clearing fields deletes only the controlled records", () => {
	const updated = profileDocumentWithEdits(sourceDocument, {
		name: "Samuel",
		bio: "",
		title: "",
		organization: "",
		location: "",
		avatarUri: "",
		links: [],
	});

	assert.deepEqual(updated.notes, {
		privateShapeButPublicData: { note: "Preserve this sibling" },
	});
	assert.equal(updated.organizations, undefined);
	assert.equal(updated.titles, undefined);
	assert.equal(updated.addresses, undefined);
	assert.deepEqual(updated.media, { banner: sourceDocument.media.banner });
	assert.equal(updated.links, undefined);
});

void test("rejects unsafe public URLs", () => {
	assert.throws(
		() =>
			profileDocumentWithEdits(sourceDocument, {
				...editableProfileFromDocument(sourceDocument),
				avatarUri: "javascript:alert(1)",
			}),
		/Avatar URL must use HTTPS/,
	);
});

void test("demo profile overrides round-trip through browser storage", () => {
	let stored: string | null = null;
	const storage = {
		getItem: () => stored,
		setItem: (_key: string, value: string) => {
			stored = value;
		},
	};
	const document = profileDocumentWithEdits(
		demoProfileDocumentWithOverride("http://localhost:8787", storage),
		{
			...editableProfileFromDocument(sourceDocument),
			name: "Edited demo",
			avatarUri: "http://localhost:8787/avatar.png",
		},
		{ allowLocalHttp: true },
	);
	saveDemoProfileDocument(document, storage);
	assert.equal(
		editableProfileFromDocument(
			demoProfileDocumentWithOverride("http://localhost:8787", storage),
		).name,
		"Edited demo",
	);
});
