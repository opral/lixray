import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const workflow = readFileSync(
	path.join(repositoryRoot, ".github/workflows/pr.yml"),
	"utf8",
);
const webSetup = readFileSync(
	path.join(repositoryRoot, ".github/actions/setup-web/action.yml"),
	"utf8",
);
const dockerfile = readFileSync(
	path.join(repositoryRoot, "web-app/Dockerfile"),
	"utf8",
);
const dockerignore = readFileSync(
	path.join(repositoryRoot, ".dockerignore"),
	"utf8",
);

function job(name) {
	const start = workflow.indexOf(`\n  ${name}:\n`);
	assert.notEqual(start, -1, `missing ${name} CI job`);
	const remaining = workflow.slice(start + 1);
	const next = remaining.slice(1).search(/^  [a-z][a-z0-9-]*:/m);
	return next === -1 ? remaining : remaining.slice(0, next + 1);
}

test("submodule revisions are validated before expensive CI lanes begin", () => {
	const selection = job("changes");
	assert.match(selection, /submodules: recursive/);
	assert.ok(
		selection.indexOf("validate-submodule-branches.sh") <
			selection.indexOf("Classify changed files"),
	);
	assert.match(job("server-image"), /needs: changes/);
	assert.match(job("web-image"), /needs:\n\s+- changes\n\s+- sdk/);
});

test("the SDK resolves tested Lix artifacts once and shares them with consumers", () => {
	const sdk = job("sdk");
	assert.match(sdk, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.match(sdk, /run: pnpm --dir web-app lix:build:native/);
	assert.match(sdk, /LIX_CI_ARTIFACT_GITHUB_TOKEN/);
	assert.match(sdk, /name: vendored-lix-sdk/);
	assert.match(sdk, /vendor\/lix\/packages\/js-sdk\/lix_js_sdk\.node/);
	assert.match(sdk, /compression-level: 0/);

	for (const name of ["frontend", "e2e"]) {
		const consumer = job(name);
		assert.match(consumer, /needs:\n\s+- changes\n\s+- sdk/);
		assert.match(consumer, /pnpm install --frozen-lockfile --ignore-scripts/);
		assert.match(consumer, /name: vendored-lix-sdk/);
		assert.match(consumer, /path: vendor\/lix\/packages/);
	}
	assert.match(job("e2e"), /run: pnpm --dir web-app exec playwright test/);
	assert.doesNotMatch(job("e2e"), /run: pnpm test:e2e/);
	assert.doesNotMatch(job("e2e"), /\.\/\.github\/actions\/setup-web/);
});

test("the server resolves the exact Lix submodule artifact with source fallback", () => {
	const server = job("server-image");
	assert.match(server, /submodules: recursive/);
	assert.match(server, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.match(server, /packages: write/);
	assert.match(server, /resolve-lix-server-image\.mjs/);
	assert.match(server, /LIX_CI_ARTIFACT_GITHUB_TOKEN/);
});

test("web image reuses the SDK artifact while direct Docker builds remain supported", () => {
	assert.match(job("web-image"), /path: \.lixray-ci\/vendored-lix-sdk/);
	assert.match(
		dockerignore,
		/!\.lixray-ci\/vendored-lix-sdk\/\*\*\/dist\/\*\*/,
	);
	assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.match(
		dockerfile,
		/cp -a \.lixray-ci\/vendored-lix-sdk\/js-sdk\/dist vendor\/lix\/packages\/js-sdk\/dist/,
	);
	assert.match(dockerfile, /else \\\n\s+pnpm --dir web-app lix:build;/);
});

test("vendored SDK cache keys track the exact Lix submodule revision", () => {
	assert.match(webSetup, /git rev-parse HEAD:vendor\/lix/);
	assert.match(webSetup, /steps\.lix-revision\.outputs\.revision/);
});

test("remote preview E2E skips Rust setup and targets visible editors", () => {
	const preview = job("preview-e2e");
	assert.match(preview, /uses: pnpm\/action-setup@v4/);
	assert.match(preview, /uses: actions\/setup-node@v4/);
	assert.doesNotMatch(preview, /\.\/\.github\/actions\/setup-web/);

	const spec = readFileSync(
		path.join(repositoryRoot, "web-app/tests/e2e/sync-preview.spec.ts"),
		"utf8",
	);
	for (const side of ["right", "left"]) {
		assert.match(
			spec,
			new RegExp(
				`const ${side}Editor = ${side}\\.locator\\(\\s*'\\.ProseMirror\\[contenteditable="true"\\]:visible'`,
			),
		);
	}
});

test("preview smoke test uses the canonical protocol and real demo Lix", () => {
	const preview = job("deploy-preview");
	assert.match(
		preview,
		/\/lix\/v1\/00000000-0000-4000-8000-000000000002\/sync\/pull/,
	);
	assert.doesNotMatch(
		preview,
		/\/lix\/v1\/11111111-1111-4111-8111-111111111111\//,
	);
});
