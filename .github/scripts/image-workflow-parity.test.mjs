import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const production = readFileSync(
	path.join(repositoryRoot, ".github/workflows/production.yml"),
	"utf8",
);
const pr = readFileSync(path.join(repositoryRoot, ".github/workflows/pr.yml"), "utf8");

function extractHashInputs(source, variable) {
	const match = source.match(
		new RegExp(`${variable}="\\$\\(([\\s\\S]*?)\\n\\s*\\)"`),
	);
	assert.ok(match, `missing ${variable} hash inputs`);
	return match[1]
		.replace(/^[ \t]+/gm, "")
		.replace(/\\\n/g, "\n")
		.trim();
}

function extractBuildStep(source, file) {
	const marker = `file: ${file}`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `missing docker build for ${file}`);
	const window = source.slice(Math.max(0, start - 200), start + 1400);
	const context = window.match(/^[\t ]*context: (.+)$/m)?.[1];
	const buildArgs = window.match(/build-args: \|\n([\s\S]*?)\n[\t ]+cache-from:/)?.[1];
	assert.ok(context, `missing context for ${file}`);
	assert.ok(buildArgs, `missing build-args for ${file}`);
	return {
		context,
		buildArgs: buildArgs.replace(/^[ \t]+/gm, "").trim(),
	};
}

test("production and PR CI hash the same server image inputs", () => {
	assert.equal(
		extractHashInputs(production, "server_inputs"),
		extractHashInputs(pr, "server_inputs"),
	);
});

test("production and PR CI hash the same web image inputs", () => {
	assert.equal(
		extractHashInputs(production, "web_inputs"),
		extractHashInputs(pr, "web_inputs"),
	);
});

test("production builds missing images with the same Dockerfiles and args as PR CI", () => {
	assert.deepEqual(
		extractBuildStep(production, "lix-server/Dockerfile"),
		extractBuildStep(pr, "lix-server/Dockerfile"),
	);
	assert.deepEqual(
		extractBuildStep(production, "web-app/Dockerfile"),
		extractBuildStep(pr, "web-app/Dockerfile"),
	);
});

test("production inspects published content tags and builds only on a miss", () => {
	assert.match(production, /if: steps\.existing\.outputs\.server_found != 'true'/);
	assert.match(production, /if: steps\.existing\.outputs\.web_found != 'true'/);
	assert.match(
		production,
		/server_digest="\$\{SERVER_BUILT_DIGEST:-\$SERVER_EXISTING_DIGEST\}"/,
	);
	assert.match(
		production,
		/web_digest="\$\{WEB_BUILT_DIGEST:-\$WEB_EXISTING_DIGEST\}"/,
	);
	assert.doesNotMatch(
		production,
		/Pull request CI must publish/,
	);
});
