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
test("only an explicitly labeled PR can deploy a preview", () => {
	assert.match(job("deploy-preview"), /contains\(github.event.pull_request.labels.\*.name, 'preview'\)/);
	assert.match(job("deploy-preview"), /needs.ci.result == 'success'/);
	assert.match(job("deploy-preview"), /\/lix\/v1\/00000000-0000-4000-8000-000000000002\/sync\/pull/);
});
test("built-image correctness uses local services without Supabase or Railway", () => {
	assert.match(integration, /PLAYWRIGHT_SYNC_LOCAL: "1"/);
	assert.match(integration, /LIXRAY_WEB_IMAGE: \$\{\{ inputs.web-image \}\}/);
	assert.doesNotMatch(integration, /supabase\/setup-cli|RAILWAY_API_TOKEN|PLAYWRIGHT_BASE_URL/);
	assert.match(integration, /if: inputs.performance != true/);
	assert.match(integration, /playwright.performance.config.ts/);
});
test("Docker requires a prepared SDK rather than compiling Rust", () => {
	const docker = read("web-app/Dockerfile");
	assert.match(docker, /Prepared SDK required/);
	assert.doesNotMatch(docker, /pnpm --dir web-app lix:build/);
});

test("the required aggregator checks out its script and ignores unrelated label cancellation", () => {
	const aggregate = job("ci");
	assert.ok(aggregate.indexOf("uses: actions/checkout@v4") < aggregate.indexOf("check-ci-results.mjs"));
	assert.match(pr, /label.name != 'preview' && 'ignored-label'/);
});
