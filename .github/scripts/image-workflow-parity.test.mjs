import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function resolveDigests(env) {
	const result = spawnSync(
		"bash",
		[
			"-c",
			`
set -euo pipefail
server_digest="\${SERVER_BUILT_DIGEST:-\$SERVER_EXISTING_DIGEST}"
web_digest="\${WEB_BUILT_DIGEST:-\$WEB_EXISTING_DIGEST}"
test -n "\$server_digest"
test -n "\$web_digest"
printf 'server=%s@%s\\nweb=%s@%s\\n' \
  "\$SERVER_REPOSITORY" "\$server_digest" \
  "\$WEB_REPOSITORY" "\$web_digest"
`,
		],
		{ encoding: "utf8", env: { ...process.env, ...env } },
	);
	return result;
}

test("resolve reuses published digests and prefers a just-built miss", () => {
	const hit = resolveDigests({
		SERVER_BUILT_DIGEST: "",
		SERVER_EXISTING_DIGEST: "sha256:server-hit",
		SERVER_REPOSITORY: "ghcr.io/opral/lixray-server",
		WEB_BUILT_DIGEST: "",
		WEB_EXISTING_DIGEST: "sha256:web-hit",
		WEB_REPOSITORY: "ghcr.io/opral/lixray-web",
	});
	assert.equal(hit.status, 0, hit.stderr);
	assert.equal(
		hit.stdout,
		"server=ghcr.io/opral/lixray-server@sha256:server-hit\nweb=ghcr.io/opral/lixray-web@sha256:web-hit\n",
	);

	const webMiss = resolveDigests({
		SERVER_BUILT_DIGEST: "",
		SERVER_EXISTING_DIGEST: "sha256:server-hit",
		SERVER_REPOSITORY: "ghcr.io/opral/lixray-server",
		WEB_BUILT_DIGEST: "sha256:web-built",
		WEB_EXISTING_DIGEST: "",
		WEB_REPOSITORY: "ghcr.io/opral/lixray-web",
	});
	assert.equal(webMiss.status, 0, webMiss.stderr);
	assert.equal(
		webMiss.stdout,
		"server=ghcr.io/opral/lixray-server@sha256:server-hit\nweb=ghcr.io/opral/lixray-web@sha256:web-built\n",
	);
});

test("resolve fails when a service still has no digest after inspect and build", () => {
	const result = resolveDigests({
		SERVER_BUILT_DIGEST: "",
		SERVER_EXISTING_DIGEST: "sha256:server-hit",
		SERVER_REPOSITORY: "ghcr.io/opral/lixray-server",
		WEB_BUILT_DIGEST: "",
		WEB_EXISTING_DIGEST: "",
		WEB_REPOSITORY: "ghcr.io/opral/lixray-web",
	});
	assert.equal(result.status, 1);
});
