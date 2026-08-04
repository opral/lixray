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

function gitlinkRevision(path) {
	const output = execFileSync("git", ["ls-tree", "HEAD", path], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	const match = /^160000 commit ([0-9a-f]{40})\t/.exec(output);
	assert.ok(match, `${path} must be a git submodule`);
	return match[1];
}

test("Railway fallback revisions match the repository submodule pointers", async () => {
	const source = await readFile(
		new URL("../../vendor/revisions.env", import.meta.url),
		"utf8",
	);
	const revisions = parseRevisionManifest(source);

	assert.equal(revisions.LIX_REVISION, gitlinkRevision("vendor/lix"));
	assert.equal(revisions.ATELIER_REVISION, gitlinkRevision("vendor/atelier"));
});

test("Railway Docker fallback uses pinned revisions instead of moving branches", async () => {
	const dockerfile = await readFile(
		new URL("../Dockerfile", import.meta.url),
		"utf8",
	);

	assert.match(dockerfile, /\. \/app\/vendor\/revisions\.env/);
	assert.match(dockerfile, /lix\/archive\/\$\{LIX_REVISION\}\.tar\.gz/);
	assert.match(dockerfile, /atelier\/archive\/\$\{ATELIER_REVISION\}\.tar\.gz/);
	assert.doesNotMatch(dockerfile, /archive\/refs\/heads\//);
});
