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
const serverResolver = readFileSync(
	path.join(repositoryRoot, "scripts/resolve-lix-server.mjs"),
	"utf8",
);

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
	const buildArgs = window.match(
		/build-args: \|\n([\s\S]*?)\n[\t ]+cache-from:/,
	)?.[1];
	assert.ok(context, "missing web build context");
	assert.ok(buildArgs, "missing web build args");
	return {
		context,
		buildArgs: buildArgs.replace(/^[ \t]+/gm, "").trim(),
	};
}

test("PR, production, and local development resolve the server from the Lix submodule", () => {
	for (const workflow of [pr, production]) {
		assert.match(
			workflow,
			/uses: \.\/\.github\/workflows\/lix-server-image\.yml/,
		);
		assert.match(workflow, /submodules: recursive/);
	}
	assert.match(compose, /image: \$\{LIXRAY_SERVER_IMAGE:-/);
	assert.match(serverResolver, /git", \["-C", lixRoot, "rev-parse", "HEAD"\]/);
	assert.match(serverResolver, /lix-server:content-\$\{inputHash\}/);
	assert.match(serverResolver, /lix-server:sha-\$\{sourceRevision\}/);
	assert.match(serverResolver, /installServerImageArtifact/);
	assert.match(serverResolver, /SOURCE BUILD/);
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
