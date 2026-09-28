import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pr = read(".github/workflows/pr.yml");
const sdk = read(".github/workflows/lix-sdk.yml");
const server = read(".github/workflows/lix-server-image.yml");
const integration = read(".github/workflows/browser-integration.yml");
function job(name) {
	const start = pr.indexOf(`\n  ${name}:\n`);
	assert.ok(start >= 0, `missing ${name}`);
	return pr.slice(start + 1).split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}
test("artifact consumers fail promptly without compilation fallback", () => {
	for (const workflow of [sdk, server]) {
		assert.doesNotMatch(workflow, /\n  build:|blacksmith|WAIT_SECONDS: "900"/);
		assert.match(workflow, /LIXRAY_LIX_ARTIFACTS: "only"/);
		assert.match(workflow, /exit 1/);
		assert.match(workflow, /https:\/\/github.com\/opral\/lix\/actions\/workflows\/ci.yml/);
	}
	assert.doesNotMatch(pr, /lix-artifacts|preview-e2e|preview-validation/);
	assert.match(sdk, /--resolve-only/);
	assert.match(server, /LIXRAY_ALLOW_SOURCE_BUILD: "false"/);
});
test("fast feedback and ordinary E2E never wait for a web image or deployment", () => {
	assert.match(job("fast"), /needs: changes/);
	assert.doesNotMatch(job("fast"), /needs:.*sdk|download-artifact|build-rust/);
	assert.doesNotMatch(job("e2e"), /web-image|PLAYWRIGHT_SYNC_LOCAL|deploy-preview/);
	assert.match(job("sync"), /browser-integration.yml/);
});
test("E2E prepares generated dependencies before Playwright imports fixtures", () => {
	for (const name of ["e2e", "e2e-components"]) {
		const lane = job(name);
		const prepare = lane.indexOf("run: pnpm --dir web-app ci:prepare:web");
		const collect = lane.indexOf("run: pnpm --dir web-app exec playwright test");
		assert.ok(prepare >= 0 && prepare < collect, name);
	}
	const scripts = JSON.parse(read("web-app/package.json")).scripts;
	assert.match(scripts["pretest:e2e"], /pnpm ci:prepare:web/);
});
test("independent browser component suites run beside Compose and remain required", () => {
	assert.match(job("e2e"), /Run Compose e2e tests/);
	assert.doesNotMatch(job("e2e"), /Test device recovery and directory review controls/);
	assert.match(job("e2e-components"), /Test device recovery and directory review controls/);
	assert.match(job("ci"), /e2e-components/);
});
test("only an explicitly labeled PR can deploy a preview", () => {
	assert.match(job("deploy-preview"), /contains\(github.event.pull_request.labels.\*.name, 'preview'\)/);
	assert.match(job("deploy-preview"), /needs.ci.result == 'success'/);
	assert.match(job("deploy-preview"), /\/lix\/v1\/00000000-0000-4000-8000-000000000002\/sync\/pull/);
});
test("fork PRs cannot enter jobs that publish images or request deployment credentials", () => {
	for (const name of ["server-image", "web-image", "deploy-preview"]) {
		assert.match(job(name), /if: >-\s+[\s\S]*?github.event.pull_request.head.repo.full_name == github.repository/);
	}
	assert.match(job("ci"), /FORK_PULL_REQUEST: \$\{\{ github.event.pull_request.head.repo.full_name != github.repository \}\}/);
	const cleanup = read(".github/workflows/railway-preview-cleanup.yml");
	assert.match(cleanup, /discover:[\s\S]*?if: github.event_name != 'pull_request' \|\| github.event.pull_request.head.repo.full_name == github.repository/);
	assert.match(cleanup, /cleanup-github:\s+if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository/);
	assert.match(cleanup, /cleanup-github:[\s\S]*?uses: actions\/checkout@v4\s+with:\s+ref: main/);
});
test("built-image correctness uses local services without Supabase or Railway", () => {
	assert.match(integration, /PLAYWRIGHT_SYNC_LOCAL: "1"/);
	assert.match(integration, /LIXRAY_WEB_IMAGE: \$\{\{ inputs.web-image \}\}/);
	assert.doesNotMatch(integration, /supabase\/setup-cli|RAILWAY_API_TOKEN|PLAYWRIGHT_BASE_URL/);
	assert.match(integration, /if: inputs.performance != true/);
	assert.match(integration, /playwright.performance.config.ts/);
});
test("local acceptance prepares a usable server image before authenticated E2E", () => {
	const local = read("scripts/ci-local.mjs");
	const resolve = local.indexOf('resolveLixServerImage({ mode: "local", allowBuild: true })');
	const e2e = local.indexOf('run("Authenticated Compose E2E"');
	assert.ok(resolve >= 0 && resolve < e2e);
	assert.match(local, /LIXRAY_SERVER_IMAGE: serverImage/);
	assert.match(local, /LIXRAY_ACCOUNT_TEST_SERVICE_URL: `http:\/\/127\.0\.0\.1:\$\{serverPort\}`/);
});
test("Docker requires a prepared SDK rather than compiling Rust", () => {
	const docker = read("web-app/Dockerfile");
	assert.match(docker, /Prepared SDK required/);
	assert.doesNotMatch(docker, /pnpm --dir web-app lix:build/);
});

test("the required aggregator checks out its script and ignores unrelated label cancellation", () => {
	const aggregate = job("ci");
	assert.ok(aggregate.indexOf("uses: actions/checkout@v4") < aggregate.indexOf("check-ci-results.mjs"));
	const select = job("changes");
	assert.match(select, /actions: read/);
	assert.ok(select.indexOf("id: classify") < select.indexOf("run: node scripts/check-pinned-lix-ci.mjs"));
	assert.match(select, /Require successful Lix CI for artifact consumers\n\s+if: >-\n\s+steps\.classify\.outputs\.frontend == 'true' \|\|\n\s+steps\.classify\.outputs\.e2e == 'true' \|\|\n\s+contains\(github\.event\.pull_request\.labels\.\*\.name, 'preview'\)/);
	assert.match(select, /GH_TOKEN: \$\{\{ secrets\.LIX_ACTIONS_READ_TOKEN \|\| github\.token \}\}/);
	for (const name of ["sdk", "server-image", "web-image", "frontend", "e2e", "e2e-components", "sync"]) {
		assert.match(job(name), /needs:[\s\S]*?changes/);
	}
	assert.match(pr, /label.name != 'preview' && 'ignored-label'/);
});

test("static UI selects fast checks without implicitly starting heavy jobs", () => {
  assert.match(job("changes"), /fast: \$\{\{ steps.classify.outputs.fast \}\}/);
  assert.match(job("fast"), /if: needs.changes.outputs.fast == 'true' \|\| needs.changes.outputs.frontend == 'true'/);
  for (const name of ["sdk", "frontend", "server-image", "web-image", "e2e", "e2e-components", "sync"]) {
    assert.doesNotMatch(job(name), /outputs.fast/);
  }
});
