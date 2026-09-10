import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	decodeEntityId,
	encodeEntityId,
	entityRoutePath,
	entityUrlSplat,
	parseEntityUrlSplat,
	entityFromRoute,
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

void test("file and directory names are optional labels, not identities", () => {
	assert.equal(
		entityUrlSplat(uuid, "/gtm/GTM playbook.md"),
		`${token}/gtm-playbook.md`,
	);
	assert.equal(
		entityRoutePath("opral", "monorepo", "directory", uuid, "/teams/GTM"),
		`/@opral/monorepo/dir/${token}/gtm`,
	);
	for (const splat of [token, `${token}/old-name`, `${token}/new-name`]) {
		assert.equal(parseEntityUrlSplat(splat)?.id, uuid);
	}
	assert.equal(parseEntityUrlSplat("gtm/GTM playbook.md"), null);
	assert.equal(parseEntityUrlSplat(`${token}/a/b`), null);
	assert.equal(
		entityFromRoute(
			`/@opral/monorepo/file/${token}/old-name`,
			"opral",
			"monorepo",
		)?.id,
		uuid,
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

void test("long Unicode labels remain URL-encodable at the truncation boundary", () => {
	const path = "/" + "a".repeat(119) + "𐐀𐐀";
	const url = entityRoutePath("opral", "monorepo", "file", uuid, path);
	assert.equal(
		decodeURIComponent(url).split("/").at(-1),
		"a".repeat(119) + "𐐨",
	);
});
