import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { seedArchitecture } from "./seed-architecture.mjs";

const samples = Number(process.env.PROTOTYPE_SAMPLES ?? 6);
const smoke = process.env.PROTOTYPE_SMOKE === "1";
const authorityBuild = process.env.PROTOTYPE_AUTHORITY_BUILD?.trim();
if (!smoke && !authorityBuild) {
	throw new Error(
		"PROTOTYPE_AUTHORITY_BUILD is required for a full profile; include the SDK source HEAD, source diff SHA-256, and authority binary SHA-256.",
	);
}
const wasmAssetIdentity = (
	await import(
		new URL("./wasm/lix_js_sdk_bg.asset.js", import.meta.resolve("@lix-js/sdk"))
			.href
	)
).default;
const workloads = smoke
	? [{ bytes: 1024, unrelatedFiles: 0, delayMs: 0 }]
	: [
			{ bytes: 1024, unrelatedFiles: 0, delayMs: 0 },
			{ bytes: 1024, unrelatedFiles: 0, delayMs: 80 },
			{ bytes: 98304, unrelatedFiles: 0, delayMs: 80 },
			{ bytes: 1024, unrelatedFiles: 500, delayMs: 80 },
		];
const browser = await chromium.launch();
const results = [];
const failures = [];

async function arm(fixture, mode, sample) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors = [];
	const failedRequests = [];
	let coldResult;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("requestfailed", (request) =>
		failedRequests.push({
			route: new URL(request.url()).pathname,
			failure: request.failure()?.errorText,
		}),
	);
	try {
		const start = performance.now();
		const params = new URLSearchParams({
			repositoryId: fixture.repositoryId,
			branchId: fixture.branchId,
			fileId: fixture.fileId,
			mode,
			delayMs: String(fixture.delayMs),
		});
		await page.goto(`http://127.0.0.1:8830/architecture.html?${params}`);
		await page.waitForFunction(
			() =>
				document.querySelector("#status")?.textContent?.endsWith(": ready") ||
				window.__architecture?.events.some(
					(event) =>
						event.name.endsWith("open_to_usable") && event.outcome !== "ok",
				),
			null,
			{ timeout: 90_000 },
		);
		assert.ok(
			(await page.locator("#status").textContent())?.endsWith(": ready"),
			await page.locator("#status").textContent(),
		);
		const navigationToUsableMs = performance.now() - start;
		const cold = await page.evaluate(() => window.__architecture.metrics());
		const coldOpen = cold.events.find((event) =>
			event.name.endsWith("open_to_usable"),
		);
		assert.equal(coldOpen?.outcome, "ok");
		coldResult = {
			mode,
			sample,
			bytes: fixture.bytes,
			unrelatedFiles: fixture.unrelatedFiles,
			delayMs: fixture.delayMs,
			navigationToUsableMs,
			coldOpenToUsableMs: coldOpen.durationMs,
			coldRequests: cold.network.length,
			coldResponseBytes: cold.network.reduce(
				(sum, request) => sum + request.responseBytes,
				0,
			),
			coldEvents: cold.events,
			coldNetwork: cold.network,
		};
		const initial = await page.evaluate(() => window.__architecture.read());
		const prepareStart = performance.now();
		await page.evaluate(() => window.__architecture.prepareOfflineEditing());
		const prepareOfflineEditingMs = performance.now() - prepareStart;
		await page.evaluate(() => window.__architecture.close());
		await context.setOffline(true);
		await page.evaluate(() => window.__architecture.setOffline(true));
		const offline = await page.evaluate(
			async ({ initial, mode, sample }) => {
				const api = window.__architecture;
				const networkBefore = api.network.length;
				const attemptsBefore = api.attempts.length;
				const reopenStart = performance.now();
				await api.open(mode);
				const offlineReopenMs = performance.now() - reopenStart;
				const reads = [];
				for (let index = 0; index < 20; index++) {
					const start = performance.now();
					if ((await api.read()) !== initial)
						throw new Error("Offline warm read differs from loaded content");
					reads.push(performance.now() - start);
				}
				const editStart = performance.now();
				const content = `${mode}:${sample}\n${initial}`;
				await api.edit(content);
				const durableEditMs = performance.now() - editStart;
				if ((await api.read()) !== content)
					throw new Error("Read-after-write failed");
				if (mode === "working-set") await api.resetCache();
				await api.close();
				await api.open(mode);
				if ((await api.read()) !== content)
					throw new Error(
						"Pending edit lost during offline reopen/cache reset",
					);
				const nativeBackgroundPublicationAttempts =
					mode === "partial"
						? api.attempts
								.slice(attemptsBefore)
								.filter(
									(attempt) =>
										attempt.method === "POST" && attempt.route === "push",
								)
						: [];
				const unexpectedRemoteSqlAttempts = api.attempts
					.slice(attemptsBefore)
					.filter((attempt) =>
						/^(?:execute|execute-batch)$/.test(attempt.route),
					);
				return {
					offlineReopenMs,
					warmReadMs: reads,
					durableEditMs,
					offlineNetworkRequests: api.network.length - networkBefore,
					offlineAttempts: api.attempts.slice(attemptsBefore),
					nativeBackgroundPublicationAttempts,
					unexpectedRemoteSqlAttempts,
					expected: content,
				};
			},
			{ initial, mode, sample },
		);
		assert.equal(offline.offlineNetworkRequests, 0);
		assert.deepEqual(
			offline.unexpectedRemoteSqlAttempts,
			[],
			"Offline local reads and edits must not issue remote SQL; native background publication uses /sync/push and is reported separately.",
		);
		assert.equal(
			offline.offlineAttempts.filter((attempt) =>
				/native-|read-fulfillment|blob|chunk/.test(attempt.route),
			).length,
			0,
			"Loaded offline work attempted data hydration",
		);
		await context.setOffline(false);
		await page.evaluate(() => window.__architecture.setOffline(false));
		const syncStart = performance.now();
		const sync = await page.evaluate(() => window.__architecture.sync());
		assert.equal(sync.status, "synced");
		const reconnectToAuthorityMs = performance.now() - syncStart;
		assert.equal(
			(await page.evaluate(() => window.__architecture.authorityRead()))
				.content,
			offline.expected,
		);
		assert.deepEqual(errors, []);
		await page.evaluate(() => window.__architecture.close());
		const metrics = await page.evaluate(() => window.__architecture.metrics());
		return {
			...coldResult,
			prepareOfflineEditingMs,
			mode,
			sample,
			bytes: fixture.bytes,
			unrelatedFiles: fixture.unrelatedFiles,
			delayMs: fixture.delayMs,
			navigationToUsableMs,
			coldOpenToUsableMs: coldOpen.durationMs,
			coldRequests: cold.network.length,
			coldResponseBytes: cold.network.reduce(
				(sum, request) => sum + request.responseBytes,
				0,
			),
			...offline,
			expected: undefined,
			reconnectToAuthorityMs,
			events: metrics.events,
			engineSpans: metrics.engineSpans,
			requests: metrics.network,
			capabilityStatus: "passed",
		};
	} catch (error) {
		await page
			.evaluate(() => window.__architecture?.close())
			.catch(() => undefined);
		console.error(
			JSON.stringify({
				mode,
				failedRequests,
				metrics: await page
					.evaluate(async () => ({
						events: window.__architecture?.events,
						attempts: window.__architecture?.attempts,
						engineSpans: window.__architecture
							? (await window.__architecture.metrics()).engineSpans
							: [],
						status: document.querySelector("#status")?.textContent,
					}))
					.catch(() => null),
			}),
		);
		if (coldResult)
			return {
				...coldResult,
				capabilityStatus: "failed",
				capabilityError: String(error),
			};
		throw error;
	} finally {
		await context.close();
	}
}

try {
	for (const workload of workloads) {
		for (let sample = 0; sample < samples; sample++) {
			// Alternate AB/BA so neither architecture always gets the first run.
			const order =
				sample % 2 === 0
					? ["partial", "working-set"]
					: ["working-set", "partial"];
			for (const mode of order) {
				try {
					const fixture = {
						...(await seedArchitecture(workload)),
						...workload,
					};
					const result = await arm(fixture, mode, sample);
					results.push(result);
					if (result.capabilityStatus === "failed")
						failures.push({
							mode,
							sample,
							...workload,
							error: result.capabilityError,
						});
					console.log(
						JSON.stringify({
							mode,
							sample,
							...workload,
							coldMs: Math.round(result.coldOpenToUsableMs),
							editMs:
								result.durableEditMs === undefined
									? null
									: Number(result.durableEditMs.toFixed(2)),
							reconnectMs:
								result.reconnectToAuthorityMs === undefined
									? null
									: Math.round(result.reconnectToAuthorityMs),
							capabilityStatus: result.capabilityStatus,
						}),
					);
				} catch (error) {
					failures.push({ mode, sample, ...workload, error: String(error) });
					console.error(JSON.stringify(failures.at(-1)));
					if (smoke) throw error;
				}
			}
		}
	}
} finally {
	await browser.close();
	await mkdir(".architecture", { recursive: true });
	await writeFile(
		".architecture/profile.json",
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				wasmAssetIdentity,
				authorityBuild: authorityBuild ?? "smoke-unpinned",
				samples,
				results,
				failures,
				notes: [
					"Same local protocol-25 authority for both arms; synthetic text fixtures. Browser WASM identified by SHA-256 above.",
					"Request delay is injected before each protocol fetch, not a full network emulator.",
					"Usable means text present in prototype textarea; production auth, tree, plugins excluded.",
					"Offline uses Chromium network disconnect plus explicit transport rejection; no network succeeds. Native partial-replica POST /sync/push attempts are recorded separately; remote SQL execute attempts fail the capability check.",
					"Both arms use actual browser durability (OPFS vs strict IndexedDB) and authoritative Lix SQL.",
					"Warm reopened measurements use the already loaded document, not offline HTML navigation.",
				],
			},
			null,
			2,
		),
	);
}
process.exit(failures.length ? 1 : 0);
