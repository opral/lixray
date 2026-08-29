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
const pr = readFileSync(
	path.join(repositoryRoot, ".github/workflows/pr.yml"),
	"utf8",
);
const compose = readFileSync(path.join(repositoryRoot, "compose.yml"), "utf8");

function pinnedLixServer(source) {
	return source.match(
		/ghcr\.io\/opral\/lix-server@sha256:[0-9a-f]{64}/,
	)?.[0];
}

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

function extractWebBuildStep(source) {
	const marker = "file: web-app/Dockerfile";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, "missing web Docker build");
	const window = source.slice(Math.max(0, start - 200), start + 1400);
	const context = window.match(/^[\t ]*context: (.+)$/m)?.[1];
	const buildArgs = window.match(/build-args: \|\n([\s\S]*?)\n[\t ]+cache-from:/)?.[1];
	assert.ok(context, "missing web build context");
	assert.ok(buildArgs, "missing web build args");
	return {
		context,
		buildArgs: buildArgs.replace(/^[ \t]+/gm, "").trim(),
	};
}

test("PR, production, and local development pin the same public Lix server", () => {
	const image = pinnedLixServer(pr);
	assert.ok(image);
	assert.equal(pinnedLixServer(production), image);
	assert.equal(pinnedLixServer(compose), image);
});

test("LixRay workflows never build or publish a Rust server image", () => {
	for (const workflow of [pr, production]) {
		assert.doesNotMatch(workflow, /file: lix-server\/Dockerfile/);
		assert.doesNotMatch(workflow, /ghcr\.io\/[^\s]+\/lixray-server/);
		assert.doesNotMatch(workflow, /build-server/);
	}
	assert.match(pr, /docker manifest inspect "\$LIX_SERVER_IMAGE"/);
	assert.match(production, /docker manifest inspect "\$LIX_SERVER_IMAGE"/);
});

test("production and PR CI hash the same web image inputs", () => {
	assert.equal(
		extractHashInputs(production, "web_inputs"),
		extractHashInputs(pr, "web_inputs"),
	);
});

test("production builds a missing web image with the same inputs as PR CI", () => {
	assert.deepEqual(extractWebBuildStep(production), extractWebBuildStep(pr));
	assert.match(production, /if: steps\.existing\.outputs\.web_found != 'true'/);
	assert.match(
		production,
		/web_digest="\$\{WEB_BUILT_DIGEST:-\$WEB_EXISTING_DIGEST\}"/,
	);
});
