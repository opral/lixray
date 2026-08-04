import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../public/manifest.webmanifest", import.meta.url);
const rootRouteUrl = new URL("../src/routes/__root.tsx", import.meta.url);

void test("the installed PWA frame matches the app background", async () => {
	const [manifestSource, rootRouteSource] = await Promise.all([
		readFile(manifestUrl, "utf8"),
		readFile(rootRouteUrl, "utf8"),
	]);
	const manifest = JSON.parse(manifestSource);
	const themeColorMatch = rootRouteSource.match(
		/\{ name: ["']theme-color["'], content: ["'](?<color>#[0-9a-fA-F]{6})["'] \}/,
	);

	assert.ok(themeColorMatch?.groups?.color, "root route defines a theme color");
	assert.equal(themeColorMatch.groups.color, manifest.theme_color);
	assert.equal(manifest.theme_color, manifest.background_color);
});
