import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	decodeEntityId,
	encodeEntityId,
	entityRouteBase,
	entityRoutePath,
	entityUrlSplat,
	parseEntityUrlSplat,
	entityFromRoute,
	canonicalEntitySplat,
	resolvePublishedEntity,
} from "./entity-url.ts";

const uuid = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
const token = "AX8i4nmwfMOYxNwMDAc5jw";

void test("UUID bytes use canonical unpadded Base64url across runtimes", () => {
	assert.equal(encodeEntityId(uuid), token);
	assert.equal(encodeEntityId(uuid.toUpperCase()), token);
	assert.equal(decodeEntityId(token), uuid);
	for (let index = 0; index < 1000; index++) {
		const bytes = createHash("sha256")
			.update(String(index))
			.digest()
			.subarray(0, 16);
		const encoded = bytes.toString("base64url");
		assert.equal(encodeEntityId(decodeEntityId(encoded)), encoded);
	}
});

void test("malformed and noncanonical tokens cannot alias an entity", () => {
	for (const invalid of [
		"",
		uuid,
		token + "=",
		token.slice(1),
		token + "/",
		token.slice(0, -1) + "x",
	]) {
		assert.throws(() => decodeEntityId(invalid));
	}
	assert.throws(() => encodeEntityId("not-a-uuid"));
});

void test("an entity URL reads as the path it opens, slugified", () => {
	assert.equal(
		entityUrlSplat(uuid, "/gtm/GTM playbook.md"),
		`${token}/gtm/gtm-playbook.md`,
	);
	assert.equal(
		entityRoutePath("opral", "monorepo", "file", uuid, "/gtm/GTM playbook.md"),
		`/@opral/monorepo/file/${token}/gtm/gtm-playbook.md`,
	);
	assert.equal(
		entityRouteBase("opral", "monorepo", "file", uuid),
		`/@opral/monorepo/file/${token}`,
	);
	// Folders read as folders; the root has no path to carry.
	assert.equal(
		entityRoutePath("opral", "monorepo", "directory", uuid, "/teams/GTM"),
		`/@opral/monorepo/folder/${token}/teams/gtm`,
	);
	assert.equal(
		entityRoutePath("opral", "monorepo", "directory", uuid, "/"),
		`/@opral/monorepo/folder/${token}`,
	);
	const parsed = parseEntityUrlSplat(`${token}/gtm/gtm-playbook.md`);
	assert.equal(parsed?.id, uuid);
	assert.equal(parsed?.path, "/gtm/gtm-playbook.md");
	assert.equal(parsed?.name, "gtm-playbook.md");
	assert.equal(parseEntityUrlSplat(token)?.path, undefined);
	assert.equal(parseEntityUrlSplat(`${token}/`)?.path, undefined);
	assert.equal(parseEntityUrlSplat("gtm/GTM playbook.md"), null);
});

void test("the id is the identity; the path is rewritten from it", () => {
	const entity = { id: uuid, path: "/gtm/Correct.md" };
	// A bare id, a stale name, and a path from another folder all resolve to
	// the same file, and each is corrected to the file's own path.
	for (const splat of [
		token,
		`${token}/peter.md`,
		`${token}/old/correct.md`,
		`${token}/gtm/correct.md/`,
	]) {
		assert.equal(parseEntityUrlSplat(splat)?.id, uuid);
		assert.equal(
			canonicalEntitySplat(splat, entity),
			`${token}/gtm/correct.md`,
		);
	}
	// Already right: nothing to rewrite, so the URL is left alone.
	assert.equal(canonicalEntitySplat(`${token}/gtm/correct.md`, entity), null);
	assert.equal(canonicalEntitySplat(token, { id: uuid, path: "/" }), null);
	// Another entity's URL is never silently adopted.
	assert.equal(
		canonicalEntitySplat("AX8i4nmwfMOYxNwMDAc5jw", {
			id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398e",
			path: "/other.md",
		}),
		"AX8i4nmwfMOYxNwMDAc5jg/other.md",
	);
});

void test("folder routes resolve by ID and the /dir alias is absent", () => {
	const entity = entityFromRoute(
		`/@opral/monorepo/folder/${token}/teams/GTM`,
		"opral",
		"monorepo",
	);
	assert.equal(entity?.id, uuid);
	assert.equal(entity?.kind, "directory");
	assert.equal(
		entityFromRoute(`/@opral/monorepo/dir/${token}`, "opral", "monorepo"),
		null,
	);
	assert.equal(
		entityFromRoute(
			`/@opral/monorepo/file/${token}/gtm/correct.md`,
			"opral",
			"monorepo",
		)?.kind,
		"file",
	);
	assert.equal(
		entityFromRoute(`/@opral/other/file/${token}`, "opral", "monorepo"),
		null,
	);
});

void test("published lookup distinguishes unavailable items from service failures", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch");
	const args = {
		namespace: "opral",
		repository: "monorepo",
		kind: "file" as const,
		id: uuid,
	};
	fetch.mock.mockImplementation(
		async () => new Response(null, { status: 404 }),
	);
	assert.equal(await resolvePublishedEntity(args), null);
	fetch.mock.mockImplementation(
		async () => new Response(null, { status: 503 }),
	);
	await assert.rejects(resolvePublishedEntity(args));
	fetch.mock.mockImplementation(async () =>
		Response.json({
			id: uuid,
			kind: "directory",
			path: "/private",
			lixId: uuid,
		}),
	);
	await assert.rejects(resolvePublishedEntity(args), /Invalid published/);
	fetch.mock.mockImplementation(async () =>
		Response.json({ id: uuid, kind: "file", path: "/renamed.md", lixId: uuid }),
	);
	assert.equal((await resolvePublishedEntity(args))?.path, "/renamed.md");
});

void test("a slug stays a plain URL segment, whatever the name holds", () => {
	for (const [path, expected] of [
		["/gtm/GTM playbook.md", "/gtm/gtm-playbook.md"],
		["/a b/c#d?e&f.md", "/a-b/c-d-e-f.md"],
		["/100% done/plan (final).md", "/100-done/plan-final.md"],
		// Lowercasing follows the script: Deseret capitals have lowercase forms.
		["/𐐀 unicode/𐐀.md", "/𐐨-unicode/𐐨.md"],
		// A name that slugs to nothing drops out; the id still resolves.
		["/??/keep.md", "/keep.md"],
		["/" + "a".repeat(300) + ".md", "/" + "a".repeat(120)],
	] as const) {
		const url = entityRoutePath("opral", "monorepo", "file", uuid, path);
		const splat = url.split("/file/")[1]!;
		assert.equal(parseEntityUrlSplat(splat)?.path, expected);
		// The router encodes a splat segment by segment the same way, so the
		// URL the app builds is the URL the router navigates to.
		assert.equal(
			splat,
			[
				token,
				...expected.split("/").filter(Boolean).map(encodeURIComponent),
			].join("/"),
		);
	}
});
