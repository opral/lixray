import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker builds require the checked-out submodules without a revision fallback", async () => {
	const [webDockerfile, serverDockerfile] = await Promise.all([
		readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
		readFile(new URL("../../lix-server/Dockerfile", import.meta.url), "utf8"),
	]);

	for (const dockerfile of [webDockerfile, serverDockerfile]) {
		assert.match(dockerfile, /initialize submodules before building/);
		assert.doesNotMatch(dockerfile, /resolve-gitlink-submodules/);
		assert.doesNotMatch(dockerfile, /RAILWAY_GIT_REPO_/);
		assert.doesNotMatch(dockerfile, /vendor\/revisions\.env/);
	}
});

test("Railway watches the submodule pointers used by each service", async () => {
	const [webConfig, serverConfig] = await Promise.all([
		readFile(new URL("../railway.json", import.meta.url), "utf8"),
		readFile(new URL("../../railway.json", import.meta.url), "utf8"),
	]).then((sources) => sources.map((source) => JSON.parse(source)));

	for (const railwayConfig of [webConfig, serverConfig]) {
		assert.ok(railwayConfig.build.watchPatterns.includes(".gitmodules"));
		assert.ok(railwayConfig.build.watchPatterns.includes("vendor/lix"));
	}
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

	assert.match(workflow, /needs\.web-image\.outputs\.image/);
	assert.match(deployPreviewJob, /uses: actions\/checkout@v4/);
	assert.match(workflow, /manage-railway-preview\.sh ensure/);
	assert.match(workflow, /manage-railway-preview\.sh url/);
	assert.match(workflow, /name: lixray-pr-/);
	assert.match(
		workflow,
		/url: \$\{\{ needs\.deploy-preview\.outputs\.preview_url \}\}/,
	);
	assert.match(workflow, /publish-preview:/);
	assert.match(workflow, /RAILWAY_DEPLOY_POLICY: pr/);
	assert.match(workflow, /promote-production\.sh/);
	assert.match(cleanupWorkflow, /manage-railway-preview\.sh delete/);
	assert.match(cleanupWorkflow, /cleanup-github-preview\.sh/);
	assert.match(cleanupWorkflow, /deployments:\s*write/);
	assert.match(cleanupWorkflow, /environments:\s*write/);
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
