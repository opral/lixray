import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function parseRevisionManifest(source) {
	return Object.fromEntries(
		source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.split("=", 2)),
	);
}

function submoduleRevision(path) {
	return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
}

test("Railway fallback revisions match the repository submodule pointers", async () => {
	const source = await readFile(
		new URL("../../vendor/revisions.env", import.meta.url),
		"utf8",
	);
	const revisions = parseRevisionManifest(source);

	assert.equal(revisions.LIX_REVISION, submoduleRevision("vendor/lix"));
	assert.equal(revisions.ATELIER_REVISION, submoduleRevision("vendor/atelier"));
});

test("Railway Docker fallback uses pinned revisions instead of moving branches", async () => {
	const [webDockerfile, serverDockerfile] = await Promise.all([
		readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
		readFile(new URL("../../lix-server/Dockerfile", import.meta.url), "utf8"),
	]);

	for (const dockerfile of [webDockerfile, serverDockerfile]) {
		assert.match(dockerfile, /vendor\/revisions\.env/);
		assert.match(dockerfile, /lix\/archive\/\$\{LIX_REVISION\}\.tar\.gz/);
		assert.doesNotMatch(dockerfile, /ARG LIX_REV/);
		assert.doesNotMatch(dockerfile, /archive\/refs\/heads\//);
	}
	assert.match(
		webDockerfile,
		/atelier\/archive\/\$\{ATELIER_REVISION\}\.tar\.gz/,
	);
});

test("Railway rebuilds services when fallback revisions change", async () => {
	const [webConfig, serverConfig] = await Promise.all([
		readFile(new URL("../railway.json", import.meta.url), "utf8"),
		readFile(new URL("../../railway.json", import.meta.url), "utf8"),
	]).then((sources) => sources.map((source) => JSON.parse(source)));

	for (const railwayConfig of [webConfig, serverConfig]) {
		assert.ok(
			railwayConfig.build.watchPatterns.includes("vendor/revisions.env"),
		);
	}
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
