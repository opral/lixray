import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Railway Docker fallback resolves submodule gitlinks from the parent commit", async () => {
	const [webDockerfile, serverDockerfile, resolver] = await Promise.all([
		readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
		readFile(new URL("../../lix-server/Dockerfile", import.meta.url), "utf8"),
		readFile(
			new URL("../../scripts/resolve-gitlink-submodules.sh", import.meta.url),
			"utf8",
		),
	]);

	for (const dockerfile of [webDockerfile, serverDockerfile]) {
		assert.match(dockerfile, /ARG RAILWAY_GIT_COMMIT_SHA/);
		assert.match(dockerfile, /resolve-gitlink-submodules\.sh/);
		assert.doesNotMatch(dockerfile, /vendor\/revisions\.env/);
	}
	assert.match(resolver, /git .* ls-tree FETCH_HEAD/);
	assert.match(resolver, /mode.*160000/);
	assert.match(resolver, /archive\/\$\{revision\}\.tar\.gz/);
	execFileSync(
		"sh",
		[
			"-n",
			fileURLToPath(
				new URL("../../scripts/resolve-gitlink-submodules.sh", import.meta.url),
			),
		],
		{ stdio: "inherit" },
	);
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
