import assert from "node:assert/strict";
import test from "node:test";
import {
	createPublishedLix,
	publishedAssetPaths,
	readPublishedFiles,
} from "./published-lix.ts";

void test("publication projection includes authorized embedded assets only", async () => {
	const file = {
		path: "/docs/README.md",
		content: new TextEncoder().encode(
			"# Published\n\n![Public](../images/public.png)\n![Private](../private.png)\n![External](https://example.com/x.png)\n![Again](../images/public.png)",
		),
	};
	assert.deepEqual(publishedAssetPaths(file), [
		"/images/public.png",
		"/private.png",
	]);
	const requested: string[] = [];
	const files = await readPublishedFiles(file, {
		readAsset: async (path) => {
			requested.push(path);
			if (path === "/private.png") throw new Error("Not public");
			return new Uint8Array([1, 2, 3]);
		},
	});
	assert.deepEqual(requested, ["/images/public.png", "/private.png"]);
	assert.deepEqual(
		files.map((row) => row.path),
		["/docs/README.md", "/images/public.png"],
	);
	assert.deepEqual(files[0]?.content, file.content);
});

void test("an aborted publication never opens a projection", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		createPublishedLix(
			{ path: "/a.md", content: new Uint8Array() },
			{ signal: controller.signal },
		),
		{ name: "AbortError" },
	);
});

void test("embedded references cannot install executable Atelier extensions", () => {
	assert.deepEqual(
		publishedAssetPaths({
			path: "/README.md",
			content: new TextEncoder().encode(
				"![Manifest](/.lix/app_data/atelier/extensions/example/manifest.json)\n![Entry](/.lix/app_data/atelier/extensions/example/index.js)",
			),
		}),
		[],
	);
});
