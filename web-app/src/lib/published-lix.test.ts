import assert from "node:assert/strict";
import test from "node:test";
import {
	openPublishedLix,
	publishedResponseError,
	publishedAssetPaths,
} from "./published-lix.ts";

void test("publication discovers embedded repository assets", async () => {
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
});

void test("an aborted publication never downloads or opens a Lix", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		openPublishedLix({
			origin: "https://lixray.test",
			repositoryId: "11111111-1111-4111-8111-111111111111",
			namespace: "opral",
			repositorySlug: "repo",
			fileId: "22222222-2222-4222-8222-222222222222",
			path: "/a.md",
			signal: controller.signal,
		}),
		{ name: "AbortError" },
	);
});

void test("embedded references cannot install executable Atelier extensions", () => {
	assert.deepEqual(
		publishedAssetPaths({
			path: "/README.md",
			content: new TextEncoder().encode(
				"![Manifest](/.lix/app_data/atelier/extensions/example/manifest.json)\n![Entry](/.lix/app_data/atelier/extensions/example/index.js)\n![Encoded](/images%2f..%2f.lix/app_data/atelier/extensions/example/index.js)",
			),
		}),
		[],
	);
});

void test("publication errors distinguish protocol failures, outages, expired views and missing files", async () => {
	assert.match(
		await publishedResponseError(new Response(null, { status: 426 })),
		/incompatible/,
	);
	for (const status of [500, 502, 503]) {
		const message = await publishedResponseError(
			new Response(null, { status }),
		);
		assert.match(message, /server could not load/);
		assert.doesNotMatch(message, /no longer public/);
	}
	assert.match(
		await publishedResponseError(new Response(null, { status: 410 })),
		/expired/,
	);
	assert.match(
		await publishedResponseError(new Response(null, { status: 404 })),
		/unavailable or is no longer public/,
	);
});
