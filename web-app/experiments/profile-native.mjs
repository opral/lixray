import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { openLix } from "@lix-js/sdk";
import { seedNative } from "./seed-native.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const outputDir = fileURLToPath(new URL("../.architecture", import.meta.url));
const previewOrigin =
	process.env.PROTOTYPE_PREVIEW_ORIGIN?.trim() || "http://127.0.0.1:8830";
const lixOrigin =
	process.env.PROTOTYPE_LIX_ORIGIN?.trim() || "http://127.0.0.1:18309";
const accountId = "00000000-0000-4000-8000-000000000031";
const delayMs = 80;
const bootstrapByteLimit = Number(
	process.env.PROTOTYPE_BOOTSTRAP_MAX_BYTES ?? 8 * 1024,
);
const bootstrapCompletedResponseLimit = 3;
const bootstrapAttemptLimit = 4;
const convergenceTimeoutMs = Number(
	process.env.PROTOTYPE_CONVERGENCE_TIMEOUT_MS ?? 20_000,
);
const samples = Number(process.env.PROTOTYPE_SAMPLES ?? 6);
const historyWorkload = Number(process.env.PROTOTYPE_UNRELATED_HISTORY ?? 500);
const smoke = process.env.PROTOTYPE_SMOKE === "1";
const coldAuthority = process.env.PROTOTYPE_COLD_AUTHORITY === "1";
const workloads = smoke
	? [{ bytes: 1024, unrelatedFiles: 0, unrelatedHistory: 0, delayMs }]
	: [
			{ unrelatedFiles: 0, unrelatedHistory: 0 },
			{ unrelatedFiles: 500, unrelatedHistory: 0 },
			{ unrelatedFiles: 5000, unrelatedHistory: 0 },
			{ unrelatedFiles: 0, unrelatedHistory: historyWorkload },
		].map((workload) => ({ bytes: 1024, delayMs, ...workload }));

assert.ok(
	Number.isSafeInteger(samples) && samples >= (smoke ? 1 : 6),
	"Full native profiles require at least six cold contexts per workload; smoke runs require one",
);
assert.ok(
	Number.isSafeInteger(historyWorkload) && historyWorkload >= 0,
	"PROTOTYPE_UNRELATED_HISTORY must be a non-negative safe integer",
);
assert.ok(
	Number.isSafeInteger(bootstrapByteLimit) && bootstrapByteLimit > 0,
	"PROTOTYPE_BOOTSTRAP_MAX_BYTES must be a positive safe integer",
);
assert.ok(
	Number.isSafeInteger(convergenceTimeoutMs) && convergenceTimeoutMs > 0,
	"PROTOTYPE_CONVERGENCE_TIMEOUT_MS must be a positive safe integer",
);

const sourceFiles = [
	"web-app/experiments/native.html",
	"web-app/experiments/native.ts",
	"web-app/experiments/profile-native.mjs",
	"web-app/experiments/seed-native.mjs",
	"web-app/experiments/summarize-native-profile.mjs",
	"web-app/experiments/vite.config.ts",
	"web-app/experiments/restart-native-authority.mjs",
];

const authorityBuildInput = process.env.PROTOTYPE_AUTHORITY_BUILD?.trim();
if (!smoke && !authorityBuildInput)
	throw new Error(
		"PROTOTYPE_AUTHORITY_BUILD is required for a full profile; include SDK and authority source HEAD/diff SHA-256 plus authority binary SHA-256 and profile.",
	);
const authorityMetadata = authorityBuildInput
	? Object.fromEntries(
			authorityBuildInput.split(";").map((field) => {
				const separator = field.indexOf("=");
				return separator < 0
					? [field.trim(), ""]
					: [
							field.slice(0, separator).trim(),
							field.slice(separator + 1).trim(),
						];
			}),
		)
	: null;
if (!smoke) {
	for (const [key, pattern] of Object.entries({
		"sdk-source-head": /^[a-f0-9]{40}$/,
		"sdk-diff-sha256": /^[a-f0-9]{64}$/,
		"authority-source-head": /^[a-f0-9]{40}$/,
		"authority-diff-sha256": /^[a-f0-9]{64}$/,
		"authority-binary-sha256": /^[a-f0-9]{64}$/,
		"authority-profile": /^(debug|release)$/,
	}))
		assert.match(
			authorityMetadata?.[key] ?? "",
			pattern,
			`Missing or invalid authority metadata: ${key}`,
		);
}

const wasmAssetIdentity = (
	await import(
		new URL("./wasm/lix_js_sdk_bg.asset.js", import.meta.resolve("@lix-js/sdk"))
			.href
	)
).default;
const wasmAssetUrl = new URL(
	"./wasm/lix_js_sdk_bg.wasm",
	import.meta.resolve("@lix-js/sdk"),
);
const wasmAssetBytes = await readFile(fileURLToPath(wasmAssetUrl));
const wasmAssetSha256 = sha256(wasmAssetBytes);
assert.equal(
	wasmAssetSha256,
	wasmAssetIdentity,
	"Resolved SDK WASM bytes do not match the SDK asset identity",
);

const authorityBinaryPath = process.env.PROTOTYPE_AUTHORITY_BINARY?.trim();
const authorityBinarySha256 = authorityBinaryPath
	? sha256(await readFile(resolve(repoRoot, authorityBinaryPath)))
	: null;
if (authorityBinarySha256 && !smoke)
	assert.equal(
		authorityBinarySha256,
		authorityMetadata?.["authority-binary-sha256"],
		"PROTOTYPE_AUTHORITY_BINARY does not match the pinned authority binary SHA-256",
	);

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function git(...args) {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

async function sourceProvenance() {
	const files = {};
	for (const path of sourceFiles) {
		const bytes = await readFile(join(repoRoot, path));
		files[path] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
	}
	const diff = git("diff", "--binary", "HEAD");
	return {
		gitHead: git("rev-parse", "HEAD"),
		worktreeDiffSha256: diff === null ? null : sha256(diff),
		files,
	};
}

async function buildProvenance() {
	const buildDir = join(repoRoot, "web-app/.architecture/dist");
	let buildStat;
	try {
		buildStat = await stat(buildDir);
	} catch {
		return { directory: "web-app/.architecture/dist", present: false };
	}
	if (!buildStat.isDirectory())
		return { directory: "web-app/.architecture/dist", present: false };

	const files = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const bytes = await readFile(absolute);
			files.push({
				path: relative(buildDir, absolute).split("\\").join("/"),
				bytes: bytes.byteLength,
				sha256: sha256(bytes),
			});
		}
	}
	await visit(buildDir);
	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		directory: "web-app/.architecture/dist",
		present: true,
		sha256: sha256(
			files
				.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`)
				.join("\n"),
		),
		files,
	};
}

function fixtureUrl(fixture) {
	const params = new URLSearchParams({
		repositoryId: fixture.repositoryId,
		branchId: fixture.branchId,
		fileId: fixture.fileId,
		delayMs: String(fixture.delayMs),
	});
	return `${previewOrigin}/native.html?${params}`;
}

function summarizePhase(network, phase) {
	const requests = network.filter((request) => request.phase === phase);
	const complete = requests.filter((request) => request.responseBytesComplete);
	const incomplete = requests.filter(
		(request) => !request.responseBytesComplete,
	);
	const declared = requests.filter(
		(request) =>
			!request.responseBytesComplete &&
			Number.isSafeInteger(request.contentLength) &&
			request.contentLength >= 0,
	);
	const unknown = incomplete.filter(
		(request) =>
			!Number.isSafeInteger(request.contentLength) || request.contentLength < 0,
	);
	return {
		requests: requests.length,
		completedResponses: complete.length,
		incompleteResponses: incomplete.length,
		unknownLengthResponses: unknown.length,
		responseBytes: complete.reduce(
			(sum, request) => sum + request.responseBytes,
			0,
		),
		declaredIncompleteBytes: declared.reduce(
			(sum, request) => sum + request.contentLength,
			0,
		),
		knownResponseBytes:
			complete.reduce((sum, request) => sum + request.responseBytes, 0) +
			declared.reduce((sum, request) => sum + request.contentLength, 0),
		byteMeasurementComplete: incomplete.length === 0,
		routes: requests.map((request) => ({
			requestId: request.requestId,
			method: request.method,
			route: request.route,
			status: request.status,
			durationMs: request.durationMs,
			responseBytes: request.responseBytes,
			contentLength: request.contentLength ?? null,
			responseBytesComplete: request.responseBytesComplete,
		})),
	};
}

function summarizeAttempts(attempts, phase) {
	const matching = attempts.filter((attempt) => attempt.phase === phase);
	return {
		count: matching.length,
		routes: matching.map((attempt) => ({
			requestId: attempt.requestId,
			method: attempt.method,
			route: attempt.route,
			phase: attempt.phase,
		})),
	};
}

function percentile(values, percentileValue) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
	);
	return sorted[index];
}

function summarizeValues(values) {
	if (values.length === 0)
		return { count: 0, min: null, median: null, p95: null, max: null };
	return {
		count: values.length,
		min: Math.min(...values),
		median: percentile(values, 50),
		p95: percentile(values, 95),
		max: Math.max(...values),
	};
}

function isDescriptorLongPollAbort(request) {
	let pathname;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return false;
	}
	return (
		request.method === "GET" &&
		pathname.includes("/descriptor") &&
		/ERR_ABORTED/.test(request.error ?? "")
	);
}

function classifyColdRequestFailure(request, repositoryId, network) {
	if (isDescriptorLongPollAbort(request)) return "descriptor-long-poll-aborted";
	if (!/ERR_ABORTED/.test(request.error ?? "") || !request.requestId)
		return "unexpected";
	let pathname;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return "unexpected";
	}
	if (
		![`/lix/${repositoryId}`, `/lix/v1/${repositoryId}`].some(
			(base) => pathname === base || pathname.startsWith(`${base}/`),
		)
	)
		return "unexpected";
	const measuredResponse = network.find(
		(response) =>
			response.requestId === request.requestId &&
			response.method === request.method &&
			response.status >= 200 &&
			response.status < 300 &&
			response.responseBytesComplete,
	);
	return measuredResponse ? "consumed-protocol-response" : "unexpected";
}

function assertSuccessfulResponses(summary, phase) {
	assert.ok(summary.requests > 0, `Expected native ${phase} requests`);
	for (const response of summary.routes) {
		assert.ok(
			response.status >= 200 && response.status < 300,
			`Native ${phase} request ${response.method} ${response.route} returned HTTP ${response.status}`,
		);
	}
}

async function readAuthority(lix, fixture) {
	const result = await lix.execute(
		"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
		[fixture.fileId],
	);
	const content = result.rows[0]?.content;
	assert.equal(typeof content, "string", "Authority target file is missing");
	return content;
}

async function waitForAuthorityContent(fixture, expected) {
	const headers = {
		Authorization: "Bearer lixray-local-internal-token",
		"x-lix-account-id": accountId,
		"x-lix-idempotency-scope": "prototype:account",
	};
	const lix = await openLix({
		server: {
			mode: "remote",
			url: `${lixOrigin}/lix/${fixture.repositoryId}`,
			headers,
		},
	});
	try {
		if ((await lix.activeBranchId()) !== fixture.branchId)
			await lix.switchBranch({ branchId: fixture.branchId });
		const start = performance.now();
		let observed;
		while (performance.now() - start < convergenceTimeoutMs) {
			observed = await readAuthority(lix, fixture);
			if (observed === expected)
				return {
					status: "converged",
					convergenceMs: performance.now() - start,
				};
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
		}
		return {
			status: "timed_out",
			convergenceTimeoutMs,
			observedContentMatches: observed === expected,
		};
	} finally {
		await lix.close();
	}
}

async function arm(fixture, sample, browser) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const pageErrors = [];
	const failedRequests = [];
	const browserRequests = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("request", (request) =>
		browserRequests.push({
			requestId: request.headers()["x-prototype-request-id"] ?? null,
			method: request.method(),
			url: request.url(),
			resourceType: request.resourceType(),
			failed: false,
		}),
	);
	page.on("requestfailed", (request) => {
		const record = browserRequests.findLast(
			(candidate) =>
				candidate.url === request.url() &&
				!candidate.failed &&
				candidate.requestId ===
					(request.headers()["x-prototype-request-id"] ?? null),
		);
		if (record) {
			record.failed = true;
			record.failure = request.failure()?.errorText ?? null;
		}
		failedRequests.push({
			requestId: request.headers()["x-prototype-request-id"] ?? null,
			method: request.method(),
			url: request.url(),
			error: request.failure()?.errorText ?? null,
		});
	});

	try {
		const navigationStart = performance.now();
		await page.goto(fixtureUrl(fixture), {
			waitUntil: "load",
			timeout: 90_000,
		});
		await page.waitForFunction(
			() => {
				const api = window.nativePrototype;
				return api?.state().ready || api?.state().phase === "failed";
			},
			null,
			{ timeout: 90_000 },
		);
		const navigationToReadyMs = performance.now() - navigationStart;
		const initialState = await page.evaluate(() =>
			window.nativePrototype.state(),
		);
		assert.equal(
			initialState.ready,
			true,
			`Native prototype did not become ready: ${initialState.phase}`,
		);
		assert.equal(initialState.repoId, fixture.repositoryId);
		assert.equal(initialState.branchId, fixture.branchId);
		assert.equal(initialState.fileId, fixture.fileId);
		assert.equal(initialState.delayMs, fixture.delayMs);
		const initial = initialState.content;
		assert.equal(initial, "a".repeat(1024));
		const navigationResources = await page.evaluate(
			(origin) =>
				performance
					.getEntriesByType("resource")
					.map((entry) => ({
						name: entry.name,
						initiatorType: entry.initiatorType,
						transferSize: entry.transferSize,
						encodedBodySize: entry.encodedBodySize,
						decodedBodySize: entry.decodedBodySize,
					}))
					.filter((entry) => entry.name.startsWith(origin)),
			previewOrigin,
		);
		const coldMetrics = await page.evaluate(() =>
			window.nativePrototype.metrics(),
		);
		const coldBrowserRequests = browserRequests.map((request) => ({
			...request,
		}));
		for (const metric of ["bootstrapMs", "scopeMs", "readyMs"])
			assert.ok(
				Number.isFinite(coldMetrics[metric]) && coldMetrics[metric] >= 0,
				`Native ${metric} must be a finite non-negative duration`,
			);
		const bootstrap = summarizePhase(coldMetrics.network, "bootstrap");
		const scope = summarizePhase(coldMetrics.network, "scope");
		bootstrap.attempts = summarizeAttempts(coldMetrics.attempts, "bootstrap");
		scope.attempts = summarizeAttempts(coldMetrics.attempts, "scope");
		assertSuccessfulResponses(bootstrap, "bootstrap");
		assertSuccessfulResponses(scope, "scope");
		for (const response of [...bootstrap.routes, ...scope.routes])
			assert.ok(
				response.durationMs >= fixture.delayMs - 2,
				`Native ${response.method} ${response.route} finished in ${response.durationMs}ms without the configured ${fixture.delayMs}ms protocol delay`,
			);
		assert.ok(
			bootstrap.completedResponses <= bootstrapCompletedResponseLimit,
			`Native bootstrap completed ${bootstrap.completedResponses} responses, above the ${bootstrapCompletedResponseLimit} response bound`,
		);
		assert.ok(
			bootstrap.attempts.count <= bootstrapAttemptLimit,
			`Native bootstrap attempted ${bootstrap.attempts.count} requests, above the ${bootstrapAttemptLimit} request bound`,
		);
		assert.ok(
			bootstrap.byteMeasurementComplete,
			"Every bootstrap response must have a complete byte measurement",
		);
		assert.equal(
			bootstrap.incompleteResponses,
			0,
			"Bootstrap response bytes must be completely measured",
		);
		assert.ok(
			bootstrap.knownResponseBytes <= bootstrapByteLimit,
			`Native bootstrap used ${bootstrap.knownResponseBytes} known response bytes, above the ${bootstrapByteLimit} byte bound`,
		);
		assert.ok(
			scope.byteMeasurementComplete,
			"Selected-file scope response byte measurements must complete",
		);
		assert.equal(
			scope.incompleteResponses,
			0,
			"Selected-file scope response bytes must be completely measured",
		);
		assert.ok(
			scope.attempts.count <= scope.requests + 1,
			"Selected-file scope should not have unexplained failed or cancelled requests",
		);
		const coldFailedRequests = [...failedRequests];
		const coldFailedRequestClassifications = coldFailedRequests.map(
			(request) => ({
				...request,
				classification: classifyColdRequestFailure(
					request,
					fixture.repositoryId,
					coldMetrics.network,
				),
			}),
		);
		assert.deepEqual(
			coldFailedRequestClassifications.filter(
				(request) => request.classification === "unexpected",
			),
			[],
			"Cold navigation should have no failed protocol request other than a cancelled descriptor or an exactly matched response whose body was completely measured",
		);
		assert.ok(
			coldFailedRequestClassifications.filter(
				(request) => request.classification === "descriptor-long-poll-aborted",
			).length <= 1,
			"At most one descriptor long-poll may be cancelled during cold navigation",
		);
		await page.evaluate(() => window.nativePrototype.resetMetrics());
		const hotLocalReadMs = await page.evaluate(
			async ({ initial }) => {
				const durations = [];
				for (let index = 0; index < 20; index++) {
					const start = performance.now();
					const content = await window.nativePrototype.read();
					if (content !== initial)
						throw new Error(
							`Hot local read ${index} returned incorrect content`,
						);
					durations.push(performance.now() - start);
				}
				return durations;
			},
			{ initial },
		);
		const hotReadMetrics = await page.evaluate(() =>
			window.nativePrototype.metrics(),
		);
		assert.deepEqual(
			hotReadMetrics.attempts.filter((attempt) => attempt.phase === "read"),
			[],
			"Prepared hot local reads must not issue protocol requests",
		);

		const cold = {
			sample,
			coldContextId: randomUUID(),
			coldContext: true,
			authorityCacheState: coldAuthority
				? "cold_process_after_fixture_seed"
				: "warm_after_fixture_seed",
			bytes: fixture.bytes,
			unrelatedFiles: fixture.unrelatedFiles,
			unrelatedHistory: fixture.unrelatedHistory,
			delayMs: fixture.delayMs,
			navigationToReadyMs,
			navigationResources,
			navigationResourceTransferBytes: navigationResources.reduce(
				(sum, resource) => sum + resource.transferSize,
				0,
			),
			hotLocalReads: summarizeValues(hotLocalReadMs),
			hotLocalReadMs,
			bootstrapMs: coldMetrics.bootstrapMs,
			scopeMs: coldMetrics.scopeMs,
			readyMs: coldMetrics.readyMs,
			bootstrap,
			scope,
			otherPhaseRequests: coldMetrics.network.filter(
				(request) => !["bootstrap", "scope"].includes(request.phase),
			),
			bootstrapAttemptCount: bootstrap.attempts.count,
			coldFailedRequests,
			coldFailedRequestClassifications,
			coldEvents: coldMetrics.events,
			coldAttempts: coldMetrics.attempts,
			coldBrowserRequests,
		};

		await page.evaluate(() => window.nativePrototype.close());
		await page.evaluate(() => window.nativePrototype.resetMetrics());
		await context.setOffline(true);
		const offlineProgress = await page.evaluate(
			async ({ initial, sample }) => {
				const api = window.nativePrototype;
				const progress = { offlineEditMs: [] };
				let start = performance.now();
				await api.reopen();
				progress.offlineReopenMs = performance.now() - start;
				if (!api.state().ready)
					throw new Error("Offline reopen did not become ready");
				if ((await api.read()) !== initial)
					throw new Error(
						"Offline read differs from the selected file content",
					);
				let next = initial;
				for (let edit = 0; edit < 3; edit++) {
					next = `${next}\noffline-profile-${sample}-edit-${edit}`;
					start = performance.now();
					await api.edit(next);
					progress.offlineEditMs.push(performance.now() - start);
					if ((await api.read()) !== next)
						throw new Error(
							`Offline read-after-write ${edit} differs from the edit`,
						);
				}
				await api.close();
				start = performance.now();
				await api.reopen();
				progress.offlineEditReopenMs = performance.now() - start;
				if (!api.state().ready || (await api.read()) !== next)
					throw new Error(
						"Offline edit did not persist across close and reopen",
					);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
				return {
					...progress,
					offlineEditCount: progress.offlineEditMs.length,
					expected: next,
				};
			},
			{ initial, sample },
		);
		const offlineMetrics = await page.evaluate(() =>
			window.nativePrototype.metrics(),
		);
		assert.deepEqual(
			offlineMetrics.network,
			[],
			"Prepared offline read/edit/reopen must not receive protocol responses",
		);
		const unapprovedOfflineAttempts = offlineMetrics.attempts.filter(
			(attempt) =>
				!(attempt.method === "POST" && attempt.route === "/sync/push"),
		);
		assert.deepEqual(
			unapprovedOfflineAttempts,
			[],
			"Offline prepared read/edit/reopen may attempt native background publication only",
		);
		assert.deepEqual(pageErrors, []);

		await context.setOffline(false);
		const convergence = await waitForAuthorityContent(
			fixture,
			offlineProgress.expected,
		);
		assert.equal(
			convergence.status,
			"converged",
			`Native background edit did not reach the authority within ${convergenceTimeoutMs}ms`,
		);
		const finalState = await page.evaluate(() =>
			window.nativePrototype.state(),
		);
		return {
			...cold,
			...offlineProgress,
			offlineEdits: summarizeValues(offlineProgress.offlineEditMs),
			coldFailedRequestClassifications,
			offlineAttempts: offlineMetrics.attempts,
			offlineNetwork: offlineMetrics.network,
			convergence,
			finalReady: finalState.ready,
			capabilityStatus: "passed",
			browserRequests,
			failedRequests,
		};
	} finally {
		await page
			.evaluate(() => window.nativePrototype?.close())
			.catch(() => undefined);
		await context.close();
	}
}

const browser = await chromium.launch();
const results = [];
const failures = [];
const provenance = {
	generatedAt: new Date().toISOString(),
	previewOrigin,
	lixOrigin,
	nodeVersion: process.version,
	browserVersion: browser.version(),
	chromiumExecutable: chromium.executablePath(),
	authorityBuild: authorityMetadata ?? "smoke-unpinned",
	authorityBinaryPath: authorityBinaryPath ?? null,
	authorityBinarySha256,
	wasmAsset: {
		sha256: wasmAssetSha256,
		bytes: wasmAssetBytes.byteLength,
		identity: wasmAssetIdentity,
	},
	bootstrapByteLimit,
	bootstrapCompletedResponseLimit,
	bootstrapAttemptLimit,
	convergenceTimeoutMs,
	samples,
	smoke,
	coldAuthority,
	workloads,
	source: await sourceProvenance(),
	build: await buildProvenance(),
};

try {
	for (let sample = 0; sample < samples; sample++) {
		const orderedWorkloads =
			sample % 2 === 0 ? workloads : [...workloads].reverse();
		for (const workload of orderedWorkloads) {
			let fixture;
			try {
				fixture = await seedNative(workload);
				if (coldAuthority)
					execFileSync(
						process.execPath,
						[
							fileURLToPath(
								new URL("./restart-native-authority.mjs", import.meta.url),
							),
						],
						{ stdio: "inherit", timeout: 40_000 },
					);
				const result = await arm(fixture, sample, browser);
				results.push(result);
				console.log(
					JSON.stringify({
						unrelatedFiles: workload.unrelatedFiles,
						unrelatedHistory: workload.unrelatedHistory,
						sample,
						navigationToReadyMs: Number(result.navigationToReadyMs.toFixed(2)),
						bootstrapMs: Number(result.bootstrapMs.toFixed(2)),
						scopeMs: Number(result.scopeMs.toFixed(2)),
						bootstrapAttempts: result.bootstrapAttemptCount,
						bootstrapBytes: result.bootstrap.responseBytes,
						scopeBytes: result.scope.knownResponseBytes,
						hotLocalReadP50Ms: Number(result.hotLocalReads.median.toFixed(3)),
						convergenceMs: Number(result.convergence.convergenceMs.toFixed(2)),
						capabilityStatus: result.capabilityStatus,
					}),
				);
			} catch (error) {
				const failure = {
					unrelatedFiles: workload.unrelatedFiles,
					unrelatedHistory: workload.unrelatedHistory,
					sample,
					repositoryId: fixture?.repositoryId,
					coldContext: true,
					capabilityStatus: "failed",
					error: String(error),
				};
				failures.push(failure);
				console.error(JSON.stringify(failure));
				if (smoke) throw error;
			}
		}
	}

	const baseGrid = workloads
		.filter((workload) => workload.unrelatedHistory === 0)
		.map((workload) => ({
			workload,
			rows: results.filter(
				(result) =>
					result.unrelatedFiles === workload.unrelatedFiles &&
					result.unrelatedHistory === 0,
			),
		}));
	if (
		!smoke &&
		baseGrid.length === 3 &&
		baseGrid.every(({ rows }) => rows.length === samples)
	) {
		const medians = baseGrid.map(({ workload, rows }) => ({
			unrelatedFiles: workload.unrelatedFiles,
			medianBootstrapBytes: percentile(
				rows.map((row) => row.bootstrap.knownResponseBytes),
				50,
			),
		}));
		const byteValues = medians.map((row) => row.medianBootstrapBytes);
		const varianceBytes = Math.max(...byteValues) - Math.min(...byteValues);
		provenance.crossGridBootstrapByteVariance = {
			status: varianceBytes <= 512 ? "passed" : "failed",
			maximum: 512,
			varianceBytes,
			byUnrelatedFiles: medians,
		};
		if (varianceBytes > 512)
			failures.push({
				kind: "cross_grid_bootstrap_byte_variance",
				capabilityStatus: "failed",
				...provenance.crossGridBootstrapByteVariance,
			});
	} else {
		provenance.crossGridBootstrapByteVariance = {
			status: smoke ? "not_applicable_to_smoke" : "incomplete_grid",
			maximum: 512,
		};
	}
	provenance.gridSummary = workloads.map((workload) => {
		const rows = results.filter(
			(result) =>
				result.unrelatedFiles === workload.unrelatedFiles &&
				result.unrelatedHistory === workload.unrelatedHistory,
		);
		return {
			unrelatedFiles: workload.unrelatedFiles,
			unrelatedHistory: workload.unrelatedHistory,
			requestedSamples: samples,
			passedSamples: rows.length,
			bootstrapMs: summarizeValues(rows.map((row) => row.bootstrapMs)),
			scopeMs: summarizeValues(rows.map((row) => row.scopeMs)),
			readyMs: summarizeValues(rows.map((row) => row.readyMs)),
			navigationToReadyMs: summarizeValues(
				rows.map((row) => row.navigationToReadyMs),
			),
			bootstrapBytes: summarizeValues(
				rows.map((row) => row.bootstrap.responseBytes),
			),
			bootstrapAttempts: summarizeValues(
				rows.map((row) => row.bootstrapAttemptCount),
			),
			scopeBytes: summarizeValues(
				rows.map((row) => row.scope.knownResponseBytes),
			),
			hotLocalReadMs: summarizeValues(
				rows.map((row) => row.hotLocalReads.median),
			),
		};
	});
	provenance.sourceAfter = await sourceProvenance();
	provenance.buildAfter = await buildProvenance();
	provenance.sourceAndBuildStable =
		JSON.stringify(provenance.source) ===
			JSON.stringify(provenance.sourceAfter) &&
		JSON.stringify(provenance.build) === JSON.stringify(provenance.buildAfter);
	if (!provenance.sourceAndBuildStable)
		failures.push({
			kind: "source_or_build_changed_during_profile",
			capabilityStatus: "failed",
		});
} finally {
	if (!provenance.sourceAfter || !provenance.buildAfter) {
		provenance.sourceAfter = await sourceProvenance().catch(() => null);
		provenance.buildAfter = await buildProvenance().catch(() => null);
		provenance.sourceAndBuildStable =
			provenance.sourceAfter !== null &&
			provenance.buildAfter !== null &&
			JSON.stringify(provenance.source) ===
				JSON.stringify(provenance.sourceAfter) &&
			JSON.stringify(provenance.build) ===
				JSON.stringify(provenance.buildAfter);
	}
	await browser.close();
	await mkdir(outputDir, { recursive: true });
	const artifactStem = `${smoke ? "profile-native-smoke" : "profile-native"}${coldAuthority ? "-cold-authority" : ""}`;
	await writeFile(
		join(outputDir, `${artifactStem}.json`),
		JSON.stringify(
			{
				...provenance,
				results,
				failures,
				notes: [
					"Each repetition uses a new Chromium browser context and a fresh provisioned repository with the same stable 1 KiB /prototype.txt fixture; the server authority is warm immediately after fixture seeding.",
					"Protocol fetches in the browser are delayed by 80 ms per request. The delay excludes fixture seeding and the separate authority convergence check.",
					"Cold navigation-to-ready includes preview HTML, JavaScript, and WASM asset loading; separate bootstrapMs/scopeMs and phase request/byte records isolate authority work.",
					"Bootstrap is bounded to 8 KiB of fully measured responses, at most three completed responses, and at most four transport attempts. One cancelled descriptor long-poll may appear as a browser request failure and is separately recorded.",
					"Scope request counts and bytes are reported for every unrelated-file count. The cross-grid bootstrap byte variance is capped at 512 bytes; scope scaling is reported from observed results.",
					"Each cold context performs 20 prepared local reads and three edits while Chromium is offline, then closes and reopens the same OPFS scope to verify persistence. POST /sync/push attempts are recorded as background publication; any other offline protocol attempt fails the capability check.",
					"Authority convergence is measured after Chromium reconnects and outside the browser open/read/edit hot path.",
					"Synthetic repository contents are disposable and contain no user data. Unrelated files have distinct 1 KiB payloads; the history-only fixture removes its temporary unrelated file after creating the requested writes.",
				],
			},
			null,
			2,
		),
	);
}

if (failures.length) process.exitCode = 1;
