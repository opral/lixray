import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker builds require the checked-out submodules without a revision fallback", async () => {
	const [webDockerfile, serverDockerfile] = await Promise.all([
		readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
		readFile(new URL("../../lix-server/Dockerfile", import.meta.url), "utf8"),
	]);

	for (const dockerfile of [webDockerfile, serverDockerfile]) {
		assert.match(dockerfile, /initialize submodules before building/);
		assert.doesNotMatch(dockerfile, /resolve-gitlink-submodules/);
		assert.doesNotMatch(dockerfile, /RAILWAY_GIT_REPO_/);
		assert.doesNotMatch(dockerfile, /vendor\/revisions\.env/);
	}
});

test("Railway watches the submodule pointers used by each service", async () => {
	const [webConfig, serverConfig] = await Promise.all([
		readFile(new URL("../railway.json", import.meta.url), "utf8"),
		readFile(new URL("../../railway.json", import.meta.url), "utf8"),
	]).then((sources) => sources.map((source) => JSON.parse(source)));

	for (const railwayConfig of [webConfig, serverConfig]) {
		assert.ok(railwayConfig.build.watchPatterns.includes(".gitmodules"));
		assert.ok(railwayConfig.build.watchPatterns.includes("vendor/lix"));
	}
	assert.ok(webConfig.build.watchPatterns.includes("vendor/atelier"));
});

test("PR previews promote both tested images instead of rebuilding source", async () => {
	const workflow = await readFile(
		new URL("../../.github/workflows/pr.yml", import.meta.url),
		"utf8",
	);

	assert.match(workflow, /needs\.web-image\.outputs\.image/);
	assert.match(workflow, /promote "\$RAILWAY_WEB_SERVICE" "\$WEB_IMAGE" web/);
	assert.match(
		workflow,
		/promote "\$RAILWAY_SERVER_SERVICE" "\$SERVER_IMAGE" server/,
	);
	assert.match(workflow, /report_status 'lixray - lixray-web'/);
	assert.match(workflow, /report_status 'lixray - lix-server'/);
});

test("Atelier resolves the vendored Lix SDK instead of npm", async () => {
	const [rootPackage, atelierPackage, lixPackage] = await Promise.all(
		[
			new URL("../../package.json", import.meta.url),
			new URL("../../vendor/atelier/package.json", import.meta.url),
			new URL("../../vendor/lix/packages/js-sdk/package.json", import.meta.url),
		].map(async (url) => JSON.parse(await readFile(url, "utf8"))),
	);

	assert.equal(
		rootPackage.pnpm.overrides["@lix-js/sdk"],
		"link:vendor/lix/packages/js-sdk",
	);
	assert.equal(
		atelierPackage.peerDependencies["@lix-js/sdk"],
		`^${lixPackage.version}`,
	);
});
