import assert from "node:assert/strict";
import test from "node:test";
import { createAtelierDocumentLinks } from "./atelier-document-links.ts";
import { encodeEntityId } from "./entity-url.ts";

const FILE_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = encodeEntityId(FILE_ID);

function links(active = "main") {
	return createAtelierDocumentLinks({
		origin: "https://lixray.test",
		namespace: "acme",
		repository: "company",
		activeBranchId: () => active,
		defaultBranchId: () => "main",
	});
}

void test("recognizes this repository's file URLs on the branch being viewed", () => {
	const url = `https://lixray.test/@acme/company/file/${TOKEN}/hello.md`;
	assert.deepEqual(links().resolve(url), { id: FILE_ID });
	// The canonical origin counts even when the app runs elsewhere, and case
	// differences in handle and slug do not matter.
	assert.deepEqual(
		links().resolve(`https://lixray.com/@Acme/Company/file/${TOKEN}`),
		{ id: FILE_ID },
	);
	// Another repository, another branch, a directory, or a foreign site: no.
	assert.equal(
		links().resolve(`https://lixray.test/@acme/other/file/${TOKEN}`),
		null,
	);
	assert.equal(links().resolve(`${url}?branch=feature`), null);
	assert.deepEqual(links("feature").resolve(`${url}?branch=feature`), {
		id: FILE_ID,
	});
	assert.equal(links("feature").resolve(url), null);
	assert.equal(
		links().resolve(`https://lixray.test/@acme/company/dir/${TOKEN}`),
		null,
	);
	assert.equal(links().resolve("https://example.com/a.md"), null);
	assert.equal(links().resolve("hello.md"), null);
	assert.equal(
		links().resolve(`https://lixray.test/@acme/company/file/not-an-id`),
		null,
	);
});

void test("a link with a path resolves by id, whatever the path says", () => {
	const file = { id: FILE_ID, path: "/docs/100% plan.md" };
	const href = links().href(file);
	// The path is for the reader: a plain, lowercase, hyphenated slug.
	assert.equal(
		href,
		`https://lixray.test/@acme/company/file/${TOKEN}/docs/100-plan.md`,
	);
	assert.deepEqual(links().resolve(href), { id: FILE_ID });
	// A stale or wrong path still opens the file the id names.
	assert.deepEqual(
		links().resolve(
			`https://lixray.test/@acme/company/file/${TOKEN}/old/peter.md`,
		),
		{ id: FILE_ID },
	);
});

void test("writes the permanent URL, with a branch only off the default", () => {
	const file = { id: FILE_ID, path: "/docs/Hello World.md" };
	// The link reads as the file it opens: its id, then its own path.
	assert.equal(
		links().href(file),
		`https://lixray.test/@acme/company/file/${TOKEN}/docs/hello-world.md`,
	);
	assert.equal(
		links("feature").href(file),
		`https://lixray.test/@acme/company/file/${TOKEN}/docs/hello-world.md?branch=feature`,
	);
	// What it writes, it recognizes.
	assert.deepEqual(links("feature").resolve(links("feature").href(file)), {
		id: FILE_ID,
	});
});
