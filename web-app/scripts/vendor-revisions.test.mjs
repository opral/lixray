import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker builds require the checked-out submodules without a revision fallback", async () => {
	const webDockerfile = await readFile(
		new URL("../Dockerfile", import.meta.url),
		"utf8",
	);

	assert.match(webDockerfile, /initialize submodules before building/);
	assert.doesNotMatch(webDockerfile, /resolve-gitlink-submodules/);
	assert.doesNotMatch(webDockerfile, /RAILWAY_GIT_REPO_/);
	assert.doesNotMatch(webDockerfile, /vendor\/revisions\.env/);
});

test("Railway builds only the web service from repository source", async () => {
	const [webConfig, serverConfig] = await Promise.all([
		readFile(new URL("../railway.json", import.meta.url), "utf8"),
		readFile(new URL("../../railway.json", import.meta.url), "utf8"),
	]).then((sources) => sources.map((source) => JSON.parse(source)));

	assert.equal(serverConfig.build, undefined);
	assert.match(serverConfig.deploy.startCommand, /LIX_SERVER_INTERNAL_TOKEN/);
	assert.match(
		serverConfig.deploy.startCommand,
		/railway\/\$RAILWAY_ENVIRONMENT_ID/,
	);
	assert.ok(webConfig.build.watchPatterns.includes(".gitmodules"));
	assert.ok(webConfig.build.watchPatterns.includes("vendor/lix"));
	assert.ok(webConfig.build.watchPatterns.includes("vendor/atelier"));
});

test("PR previews promote both tested images instead of rebuilding source", async () => {
	const [workflow, cleanupWorkflow, coordinator] = await Promise.all([
		readFile(
			new URL("../../.github/workflows/pr.yml", import.meta.url),
			"utf8",
		),
		readFile(
			new URL(
				"../../.github/workflows/railway-preview-cleanup.yml",
				import.meta.url,
			),
			"utf8",
		),
		readFile(
			new URL("../../.github/scripts/promote-production.sh", import.meta.url),
			"utf8",
		),
	]);
	const deployPreviewJob = workflow.slice(
		workflow.indexOf("  deploy-preview:"),
		workflow.indexOf("  publish-preview:"),
	);
	const webImageJob = workflow.slice(
		workflow.indexOf("  web-image:"),
		workflow.indexOf("  frontend:"),
	);
	const ciJob = workflow.slice(
		workflow.indexOf("  ci:"),
		workflow.indexOf("  deploy-preview:"),
	);

	assert.match(workflow, /needs\.web-image\.outputs\.image/);
	assert.match(workflow, /ghcr\.io\/opral\/lix-server@sha256:[0-9a-f]{64}/);
	assert.doesNotMatch(workflow, /file: lix-server\/Dockerfile/);
	assert.doesNotMatch(webImageJob, /pull_request\.draft/);
	assert.match(
		ciJob,
		/if test "\$DRAFT" = "true"; then[\s\S]*require_success "Server image" "\$SERVER_IMAGE_RESULT"[\s\S]*require_success "Web image" "\$WEB_IMAGE_RESULT"/,
	);
	assert.match(deployPreviewJob, /uses: actions\/checkout@v4/);
	assert.match(workflow, /manage-railway-preview\.sh ensure/);
	assert.match(workflow, /manage-railway-preview\.sh url/);
	assert.match(workflow, /name: lixray-pr-/);
	assert.match(
		workflow,
		/url: \$\{\{ needs\.deploy-preview\.outputs\.preview_url \}\}/,
	);
	assert.match(workflow, /publish-preview:/);
	assert.match(workflow, /preview-e2e:/);
	assert.match(workflow, /PLAYWRIGHT_SYNC_PREVIEW: "1"/);
	assert.match(workflow, /PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID:/);
	assert.match(
		workflow,
		/deployment_id: \$\{\{ steps\.promote\.outputs\.web_deployment_id \}\}/,
	);
	assert.match(workflow, /tests\/e2e\/sync-preview\.spec\.ts/);
	assert.match(workflow, /RAILWAY_DEPLOY_POLICY: pr/);
	assert.match(workflow, /promote-production\.sh/);
	assert.match(cleanupWorkflow, /manage-railway-preview\.sh delete/);
	assert.match(cleanupWorkflow, /cleanup-github-preview\.sh/);
	assert.match(cleanupWorkflow, /deployments:\s*write/);
	assert.doesNotMatch(cleanupWorkflow, /environments:\s*write/);
	assert.doesNotMatch(cleanupWorkflow, /GITHUB_ENVIRONMENT_ADMIN_TOKEN:\?/);
	assert.match(
		coordinator,
		/update_service "\$RAILWAY_WEB_SERVICE" "\$WEB_IMAGE"/,
	);
	assert.match(
		coordinator,
		/update_service "\$RAILWAY_SERVER_SERVICE" "\$SERVER_IMAGE"/,
	);
	assert.match(workflow, /report_status 'lixray - lixray-web'/);
	assert.match(workflow, /report_status 'lixray - lix-server'/);
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
	assert.ok(
		atelierPeerSatisfiesVendoredSdk(
			atelierPackage.peerDependencies["@lix-js/sdk"],
			lixPackage.version,
		),
		`Atelier peer ${atelierPackage.peerDependencies["@lix-js/sdk"]} must accept vendored ${lixPackage.version}`,
	);
});

function atelierPeerSatisfiesVendoredSdk(peerRange, version) {
	const peer = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(peerRange);
	const vendored = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!peer || !vendored) return false;
	const [, peerMajor, peerMinor, peerPatch] = peer.map(Number);
	const [, major, minor, patch] = vendored.map(Number);
	if (major !== peerMajor) return false;
	if (minor !== peerMinor) return false;
	return patch >= peerPatch;
}
