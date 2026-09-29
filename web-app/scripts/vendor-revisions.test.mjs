import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
	const [workflow, cleanupWorkflow, coordinator, serverWorkflow] =
		await Promise.all([
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
			readFile(
				new URL(
					"../../.github/workflows/lix-server-image.yml",
					import.meta.url,
				),
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
	assert.match(
		workflow,
		/uses: \.\/\.github\/workflows\/lix-server-image\.yml/,
	);
	assert.match(serverWorkflow, /resolve-lix-server-image\.mjs/);
	assert.doesNotMatch(workflow, /file: lix-server\/Dockerfile/);
	assert.doesNotMatch(webImageJob, /pull_request\.draft/);
	assert.match(ciJob, /check-ci-results.mjs/);
	assert.match(deployPreviewJob, /uses: actions\/checkout@v4/);
	assert.match(workflow, /manage-railway-preview\.sh ensure/);
	assert.match(workflow, /manage-railway-preview\.sh url/);
	assert.match(workflow, /name: lixray-pr-/);
	assert.match(
		workflow,
		/url: \$\{\{ needs\.deploy-preview\.outputs\.preview_url \}\}/,
	);
	assert.match(workflow, /publish-preview:/);
	assert.match(deployPreviewJob, /labels.\*.name, 'preview'/);
	assert.match(workflow, /browser-integration.yml/);

	assert.match(
		workflow,
		/deployment_id: \$\{\{ steps\.promote\.outputs\.web_deployment_id \}\}/,
	);

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
	const peerRange = atelierPackage.peerDependencies["@lix-js/sdk"];
	if (atelierPeerSatisfiesVendoredSdk(peerRange, lixPackage.version)) return;

	// A source checkout can contain the next breaking API before release
	// automation updates package versions. Validate that checkout against the
	// same non-mutating release plan used by Lix, never a hardcoded exception.
	const lixRoot = new URL("../../vendor/lix/", import.meta.url);
	const { currentVersion, loadChanges, highestChangeType, bumpVersion } =
		await import(new URL("scripts/release.mjs", lixRoot).href);
	const root = fileURLToPath(lixRoot);
	assert.equal(currentVersion(root), lixPackage.version);
	const changes = loadChanges(root);
	assert.ok(
		changes.length > 0,
		`Atelier peer ${peerRange} rejects vendored ${lixPackage.version} and no release is planned`,
	);
	const plannedVersion = bumpVersion(
		lixPackage.version,
		highestChangeType(changes),
	);
	assert.ok(
		atelierPeerSatisfiesVendoredSdk(peerRange, plannedVersion),
		`Atelier peer ${peerRange} must accept vendored ${lixPackage.version} or its planned release ${plannedVersion}`,
	);
});

function atelierPeerSatisfiesVendoredSdk(peerRange, version) {
	const vendored = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!vendored) return false;
	const candidate = vendored.slice(1).map(Number);
	const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(peerRange);
	if (caret) {
		const minimum = caret.slice(1).map(Number);
		return (
			candidate[0] === minimum[0] &&
			candidate[1] === minimum[1] &&
			candidate[2] >= minimum[2]
		);
	}
	// Atelier may leave its range open upward: it follows newer Lix releases.
	const minimumOnly = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(peerRange);
	if (minimumOnly) {
		return compareSemver(candidate, minimumOnly.slice(1).map(Number)) >= 0;
	}
	const interval = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/.exec(
		peerRange,
	);
	if (!interval) return false;
	const minimum = interval.slice(1, 4).map(Number);
	const maximum = interval.slice(4, 7).map(Number);
	return (
		compareSemver(candidate, minimum) >= 0 &&
		compareSemver(candidate, maximum) < 0
	);
}

function compareSemver(left, right) {
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

test("the image build SHA reaches both the builder and production telemetry", async () => {
	const dockerfile = await readFile(
		new URL("../Dockerfile", import.meta.url),
		"utf8",
	);
	const workflow = await readFile(
		new URL("../../.github/workflows/web-image.yml", import.meta.url),
		"utf8",
	);
	assert.match(workflow, /RAILWAY_GIT_COMMIT_SHA=\$\{\{ github\.sha \}\}/);
	const stages = dockerfile.split(/^FROM /m).slice(1);
	assert.equal(stages.length, 2);
	for (const stage of stages)
		assert.match(stage, /^ARG RAILWAY_GIT_COMMIT_SHA$/m);
	assert.match(
		stages[0],
		/RAILWAY_GIT_COMMIT_SHA=\$\{RAILWAY_GIT_COMMIT_SHA\}/,
	);
	assert.match(
		stages[1],
		/^ENV LIXRAY_RELEASE_ID=\$\{RAILWAY_GIT_COMMIT_SHA\}$/m,
	);
});
