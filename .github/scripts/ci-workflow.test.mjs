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
const serverResolver = readFileSync(
	path.join(repositoryRoot, "scripts/resolve-lix-server.mjs"),
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
const webPackage = JSON.parse(
	readFileSync(path.join(repositoryRoot, "web-app/package.json"), "utf8"),
);

const sdkWorkflow = readFileSync(
	path.join(repositoryRoot, ".github/workflows/lix-sdk.yml"),
	"utf8",
);
const serverWorkflow = readFileSync(
	path.join(repositoryRoot, ".github/workflows/lix-server-image.yml"),
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
	assert.match(job("server-image"), /needs:\n\s+- changes\n\s+- lix-artifacts/);
	assert.match(job("web-image"), /needs:\n\s+- changes\n\s+- sdk/);
});

test("exact-revision Lix artifacts wait once on a GitHub-hosted runner", () => {
	const gate = job("lix-artifacts");
	assert.match(gate, /name: Await Lix artifacts/);
	assert.match(gate, /runs-on: ubuntu-latest/);
	assert.match(gate, /LIX_CI_ARTIFACT_WAIT_SECONDS: "900"/);
	assert.match(gate, /await-lix-artifacts\.mjs/);
	assert.doesNotMatch(gate, /blacksmith/);

	for (const name of ["sdk", "server-image"]) {
		const consumer = job(name);
		assert.match(consumer, /needs:\n\s+- changes\n\s+- lix-artifacts/);
		assert.match(
			name === "sdk" ? sdkWorkflow : serverWorkflow,
			/LIX_CI_ARTIFACT_WAIT_SECONDS: "0"/,
		);
	}
});

test("the SDK resolves tested Lix artifacts once and shares them with consumers", () => {
	const sdk = sdkWorkflow;
	assert.match(sdk, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.match(sdk, /run: pnpm --dir web-app lix:build/);
	assert.match(sdk, /LIX_CI_ARTIFACT_GITHUB_TOKEN/);
	assert.match(sdk, /name: vendored-lix-sdk/);
	assert.doesNotMatch(sdk, /lix_js_sdk\.node/);
	assert.match(sdk, /compression-level: 0/);
	assert.match(webPackage.scripts["ci:prepare"], /pnpm lix:build /);
	assert.doesNotMatch(webPackage.scripts["ci:prepare"], /lix:build:native/);
	assert.doesNotMatch(webPackage.scripts.pretypecheck, /lix:build:native/);

	for (const name of ["frontend", "e2e"]) {
		const consumer = job(name);
		assert.match(consumer, /needs:\n\s+- changes\n\s+- sdk/);
		assert.match(consumer, /pnpm install --frozen-lockfile --ignore-scripts/);
		assert.match(consumer, /name: vendored-lix-sdk/);
		assert.match(consumer, /path: vendor\/lix\/packages/);
	}
	assert.match(job("e2e"), /run: pnpm --dir web-app exec playwright test/);
	assert.match(job("e2e"), /uses: docker\/login-action@v3/);
	assert.doesNotMatch(job("e2e"), /run: pnpm test:e2e/);
	assert.doesNotMatch(job("e2e"), /\.\/\.github\/actions\/setup-web/);
});

test("the server resolves the exact Lix submodule artifact with source fallback", () => {
	const server = serverWorkflow;
	assert.match(server, /submodules: recursive/);
	assert.match(
		server,
		/pnpm install --filter lixray-repository --frozen-lockfile --ignore-scripts/,
	);
	assert.match(server, /build-rust: "false"/);
	assert.match(server, /packages: write/);
	assert.match(server, /resolve-lix-server-image\.mjs/);
	assert.match(server, /LIX_CI_ARTIFACT_GITHUB_TOKEN/);
	assert.ok(
		serverResolver.indexOf("HIT previously published feature image") <
			serverResolver.indexOf("artifact = await installArtifact"),
		"feature images should be checked before downloading Lix artifacts",
	);
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

test("exhaustive sync runs locally without a Railway deployment", () => {
	const local = job("e2e");
	assert.match(local, /PLAYWRIGHT_SYNC_LOCAL: "1"/);
	assert.match(local, /LIXRAY_DEMO: "1"/);
	assert.match(local, /playwright test tests\/e2e\/sync-preview\.spec\.ts/);
	assert.doesNotMatch(
		local,
		/PLAYWRIGHT_BASE_URL|PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID/,
	);
	assert.doesNotMatch(workflow, /  preview-e2e:/);

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

test("artifact hits and ordinary checks use standard GitHub runners, with paid compilation fallback", () => {
	for (const source of [sdkWorkflow, serverWorkflow]) {
		assert.match(
			source,
			/name: Reuse tested[\s\S]*?runs-on: ubuntu-(?:24\.04|slim)/,
		);
		assert.match(
			source,
			/name: Build[\s\S]*?needs: resolve[\s\S]*?runs-on: blacksmith-32vcpu-ubuntu-2404/,
		);
	}
	assert.match(sdkWorkflow, /lix:build --resolve-only/);
	assert.match(sdkWorkflow, /if: steps\.resolve\.outputs\.ready == 'true'/);
	assert.match(serverWorkflow, /LIXRAY_ALLOW_SOURCE_BUILD: "false"/);
	for (const name of ["frontend", "database", "e2e"]) {
		assert.match(job(name), /runs-on: ubuntu-24\.04/);
	}
	assert.match(
		job("web-image"),
		/needs\.sdk\.result == 'success' && 'ubuntu-24\.04'/,
	);
});
