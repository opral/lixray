import { showLibraryFiles } from "./library-fixture";
import { getCompatibility } from "../../../vendor/lix/scripts/compatibility.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page,
	type Request,
} from "@playwright/test";
import { provisionRepositories } from "../../scripts/provision-repositories.mjs";

import {
	createMergeReplayTracker,
	createRetainedBodyRecoveryTracker,
	isRetainedBodyUpload,
	isRetryableMergeConflict,
} from "./retained-body-recovery";
import { createOfflineConsoleRequestTracker } from "./offline-console-request-tracker";
import { createTransientPushRecoveryTracker } from "./transient-push-recovery";

import {
	installSyncDiagnostics,
	collectSyncDiagnostics,
} from "./sync-diagnostics";

const compatibility = getCompatibility();

const DEMO_REPOSITORY_ID = "00000000-0000-4000-8000-000000000002";
const SECONDARY_REPOSITORY_ID = "00000000-0000-4000-8000-000000000005";
export type SyncScenario =
	| "navigation"
	| "editing"
	| "history"
	| "conflicts"
	| "performance";

export async function createSyncFixture({
	browser,
	baseURL,
	scenario,
}: {
	browser: Browser;
	baseURL: string | undefined;
	scenario: SyncScenario;
}) {
	const local = process.env.PLAYWRIGHT_SYNC_LOCAL === "1";
	const analyticsStubFailures: string[] = [];
	const newContext = async () => {
		const context = await browser.newContext();
		if (
			scenario === "editing" ||
			scenario === "history" ||
			scenario === "conflicts" ||
			scenario === "performance"
		)
			await installSyncDiagnostics(context);
		if (local && scenario !== "performance") {
			// Analytics is not part of the sync contract. Keep a built production
			// image's telemetry off external networks and use an empty flag set.
			await context.route(/^https:\/\/[^/]+\.posthog\.com\//, (route) =>
				route.fulfill({
					status: 200,
					contentType:
						route.request().resourceType() === "script"
							? "application/javascript"
							: "application/json",
					body:
						route.request().resourceType() === "script"
							? ""
							: JSON.stringify({ featureFlags: {}, featureFlagPayloads: {} }),
				}),
			);
		}
		return context;
	};
	const newPage = async (context: BrowserContext) => {
		const page = await context.newPage();
		if (local && scenario === "performance") {
			// Playwright context.route disables the HTTP cache for all requests.
			// Narrow CDP interception leaves application assets cacheable while
			// keeping this Chromium performance scenario off analytics networks.
			const session = await context.newCDPSession(page);
			session.on(
				"Fetch.requestPaused",
				(event: {
					requestId: string;
					resourceType?: string;
					request: { headers: Record<string, string> };
				}) => {
					const script = event.resourceType === "Script";
					const origin =
						event.request.headers.Origin ?? event.request.headers.origin ?? "*";
					void session
						.send("Fetch.fulfillRequest", {
							requestId: event.requestId,
							responseCode: 200,
							responseHeaders: [
								{
									name: "Content-Type",
									value: script ? "application/javascript" : "application/json",
								},
								{ name: "Access-Control-Allow-Origin", value: origin },
								{ name: "Access-Control-Allow-Credentials", value: "true" },
								{
									name: "Access-Control-Allow-Methods",
									value: "GET, POST, OPTIONS",
								},
								{
									name: "Access-Control-Allow-Headers",
									value:
										event.request.headers["Access-Control-Request-Headers"] ??
										event.request.headers["access-control-request-headers"] ??
										"Content-Type",
								},
							],
							body: Buffer.from(
								script
									? ""
									: JSON.stringify({
											featureFlags: {},
											featureFlagPayloads: {},
										}),
							).toString("base64"),
						})
						.catch((error: unknown) => {
							if (!page.isClosed()) analyticsStubFailures.push(String(error));
						});
				},
			);
			await session.send("Fetch.enable", {
				patterns: [{ urlPattern: "https://*.posthog.com/*" }],
			});
		}
		return page;
	};

	test.skip(
		!local && !process.env.PLAYWRIGHT_SYNC_PREVIEW,
		"requires the local sync stack or an explicitly selected deployed preview",
	);
	if (!baseURL) throw new Error("Playwright baseURL is required");
	const expectedDeploymentId = process.env.PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID;
	if (local) {
		// This mode provisions disposable demo repositories. Never let a local
		// CI invocation accidentally mutate a remote service or deployment.
		const loopback = (url: string) =>
			["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
		const serviceUrl = process.env.LIXRAY_LIX_SERVICE_URL;
		if (!loopback(baseURL) || !serviceUrl || !loopback(serviceUrl)) {
			throw new Error("Local sync requires loopback web and Lix service URLs");
		}
	} else if (!expectedDeploymentId) {
		throw new Error("PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID is required");
	}

	// The demo frontend exposes two fixed repositories. Scenarios use fresh
	// browser contexts and explicit seeds on a disposable stack. CI gives each
	// scenario its own stack and storage prefix.
	const repositoryId = DEMO_REPOSITORY_ID;
	let describedCheckpoint:
		| { commitId: string; conversationId: string; title: string }
		| undefined;
	let repositoryUrl = new URL("/@acme/launch-q3", baseURL).toString();
	const realtimeTimeout = 30_000;
	const repositoryOperationTimeout = 90_000;
	const sharedContext = await newContext();
	const contexts = [sharedContext];
	try {
		const [left, right] = await Promise.all([
			newPage(sharedContext),
			newPage(sharedContext),
		]);
		const healthResponse = await contexts[0]!.request.get(
			new URL("/healthz", baseURL).toString(),
		);
		expect(healthResponse.status()).toBe(200);
		if (local) {
			expect(await healthResponse.json()).toMatchObject(
				process.env.LIXRAY_WEB_IMAGE
					? { ok: true, service: "lixray" }
					: { status: "ok" },
			);
			await (
				provisionRepositories as (options: {
					mode: "create-new";
					ids: string[];
					webUrl: string;
				}) => Promise<void>
			)({
				mode: "create-new",
				webUrl: baseURL,
				ids:
					scenario === "navigation"
						? [DEMO_REPOSITORY_ID, SECONDARY_REPOSITORY_ID]
						: [repositoryId],
			});
		} else {
			expect(healthResponse.headers()["x-railway-deployment-id"]).toBe(
				expectedDeploymentId,
			);
			expect(await healthResponse.json()).toMatchObject({
				ok: true,
				service: "lixray",
				deploymentId: expectedDeploymentId,
			});
		}

		// Both fresh local stacks and explicitly verified preview deployments need
		// an older checkpoint to exercise history. Seed only missing prerequisites
		// in this fixed disposable demo repository; reruns preserve existing history.
		const endpoint = new URL(`/lix/v1/${repositoryId}/`, baseURL);
		const authorization = {
			Authorization: "Bearer lixray-demo",
			"Lix-Server-Protocol-Version": String(
				compatibility.serverProtocolVersion,
			),
		};
		const opened = await sharedContext.request.get(endpoint.toString(), {
			headers: authorization,
		});
		expect(opened.ok()).toBe(true);
		const { sessionId } = (await opened.json()) as { sessionId: string };
		const headers = { ...authorization, "Lix-Session-Id": sessionId };
		try {
			const countResponse = await sharedContext.request.post(
				new URL("execute", endpoint).toString(),
				{
					headers: {
						...headers,
						"Idempotency-Key": `fixture-count-${scenario}-${randomUUID()}`,
					},
					data: {
						sql: "SELECT count(*) AS checkpoint_count FROM lix_log() WHERE is_checkpoint",
						params: [],
					},
				},
			);
			expect(countResponse.ok(), await countResponse.text()).toBe(true);
			const countResult = (await countResponse.json()) as {
				rows?: Array<Array<{ value?: unknown }>>;
			};
			const checkpointCount = countResult.rows?.[0]?.[0]?.value;
			if (
				typeof checkpointCount !== "number" ||
				!Number.isSafeInteger(checkpointCount) ||
				checkpointCount < 0
			) {
				throw new Error(
					"Fixture authority returned an invalid checkpoint count",
				);
			}
			for (let index = checkpointCount; index < 2; index++) {
				const checkpoint = await sharedContext.request.post(
					new URL("execute", endpoint).toString(),
					{
						headers: {
							...headers,
							"Idempotency-Key": `fixture-checkpoint-${scenario}-${randomUUID()}`,
						},
						data: {
							sql: "SELECT commit_id FROM lix_create_checkpoint(NULL, NULL)",
							params: [],
						},
					},
				);
				expect(checkpoint.ok(), await checkpoint.text()).toBe(true);
			}
			if (scenario === "history") {
				const title = `Qualification ${randomUUID()}`;
				const response = await sharedContext.request.post(
					new URL("execute", endpoint).toString(),
					{
						headers: {
							...headers,
							"Idempotency-Key": `described-checkpoint-${randomUUID()}`,
						},
						data: {
							sql: "SELECT commit_id FROM lix_create_checkpoint($1, NULL)",
							params: [{ kind: "text", value: title }],
						},
					},
				);
				expect(response.ok(), await response.text()).toBe(true);
				const created = (await response.json()) as {
					rows?: Array<Array<{ value?: unknown }>>;
				};
				const commitId = created.rows?.[0]?.[0]?.value;
				if (typeof commitId !== "string")
					throw new Error("Missing described checkpoint ID");
				const pointer = await sharedContext.request.post(
					new URL("execute", endpoint).toString(),
					{
						headers: {
							...headers,
							"Idempotency-Key": `checkpoint-conversation-${randomUUID()}`,
						},
						data: {
							sql: "SELECT conversation_id FROM lix_log() WHERE commit_id = $1",
							params: [{ kind: "text", value: commitId }],
						},
					},
				);
				expect(pointer.ok(), await pointer.text()).toBe(true);
				const result = (await pointer.json()) as {
					rows?: Array<Array<{ value?: unknown }>>;
				};
				const conversationId = result.rows?.[0]?.[0]?.value;
				if (typeof conversationId !== "string")
					throw new Error("Missing authority conversation ID");
				describedCheckpoint = { commitId, conversationId, title };
			}
		} finally {
			const closed = await sharedContext.request.delete(
				new URL("session", endpoint).toString(),
				{ headers },
			);
			expect(closed.ok()).toBe(true);
		}

		if (local) {
			await left.goto(new URL("/home", baseURL).toString());
			const link = left
				.getByTestId("repository-link")
				.and(left.locator(`[data-repository-id="${repositoryId}"]`));
			await expect(link).toBeVisible();
			const href = await link.getAttribute("href");
			if (!href)
				throw new Error("Seeded sync repository has no directory route");
			repositoryUrl = new URL(href, baseURL).toString();
		}

		const cacheProbeUrl = new URL(
			`/lix/v1/${repositoryId}/sync/pull?after=18446744073709551615&limit=512`,
			baseURL,
		).toString();
		await left.goto(new URL("/", baseURL).toString());
		const cacheProbes = await left.evaluate(
			async ({ url, compatibility }) => {
				const probe = async () => {
					const response = await fetch(url, {
						headers: {
							Authorization: "Bearer lixray-demo",
							"Lix-Session-Id": "0".repeat(64),
							"Lix-Sync-Protocol-Version": String(
								compatibility.syncProtocolVersion,
							),
							"Lix-Server-Protocol-Version": String(
								compatibility.serverProtocolVersion,
							),
						},
					});
					return {
						status: response.status,
						cacheControl: response.headers.get("cache-control"),
						requestId: response.headers.get("x-railway-request-id"),
					};
				};
				return [await probe(), await probe()];
			},
			{ url: cacheProbeUrl, compatibility: getCompatibility() },
		);
		for (const probe of cacheProbes) {
			expect(probe).toMatchObject({ status: 410, cacheControl: "no-store" });
			if (!local) expect(probe.requestId).toBeTruthy();
		}
		if (!local) {
			expect(cacheProbes[1]!.requestId).not.toBe(cacheProbes[0]!.requestId);
		}
		const syncFailures: string[] = [];
		const syncFailureDetails: string[] = [];
		const transientPushRecovery = createTransientPushRecoveryTracker();
		const pendingSyncFailureDetails = new Set<Promise<void>>();
		const mergeReplay = createMergeReplayTracker();
		const pendingMergeClassifications = new Set<Promise<void>>();
		const recoveredMergeConflicts: string[] = [];
		const retainedBodyRecovery = createRetainedBodyRecoveryTracker();
		const runtimeFailures: string[] = [];
		const transientPushConsoleFailures: Array<{
			source: string;
			url: string;
			message: string;
		}> = [];
		const offlineContexts = new WeakSet<BrowserContext>();
		const offlineRequests = new WeakSet<Request>();
		const coldReads = new Map<Page, string[]>();
		const pendingColdReads = new Map<Page, Set<Request>>();
		const blobLaneRequests = new Map<Page, string[]>();
		const blobLanePayloadSizes = new Map<Page, number[]>();
		const pendingBlobLaneResponses = new Set<Promise<void>>();
		const pendingBlobLaneRequests = new Set<Request>();
		const unreadableBlobLaneResponses = new Map<Request, string>();
		const blobLaneObservationFailures: string[] = [];
		const openHistoryPanel = async (page: Page) => {
			const secondary = page.getByRole("complementary", {
				name: "Secondary",
				exact: true,
			});
			const history = secondary.getByRole("region", {
				name: "Checkpoint history",
			});
			const selectRepositoryScope = async () => {
				const scopeSwitch = secondary.getByRole("button", {
					name: "Showing this file. Switch to the repository",
					exact: true,
				});
				if (await scopeSwitch.isVisible()) await scopeSwitch.click();
				return history;
			};
			if (await history.isVisible()) return selectRepositoryScope();
			const panelToggle = page.getByRole("button", {
				name: "Toggle right panel",
			});
			if ((await panelToggle.getAttribute("aria-pressed")) === "false") {
				await panelToggle.click();
			}
			const historyTab = secondary
				.getByRole("button", { name: "History", exact: true })
				.last();
			const selectedHistoryMenu = secondary.getByRole("button", {
				name: "History panel view menu",
				exact: true,
			});
			await expect(
				history.or(historyTab).or(selectedHistoryMenu).first(),
			).toBeVisible({ timeout: 30_000 });
			if (
				!(await history.isVisible()) &&
				!(await selectedHistoryMenu.isVisible())
			) {
				await historyTab.click();
			}
			await expect(history).toBeVisible({ timeout: 30_000 });
			// The authority count describes the repository timeline, while History
			// follows the active file by default. Select the matching product scope.
			return selectRepositoryScope();
		};
		let authorityReadSequence = 0;
		const authorityScalar = async (
			sql: string,
			params: Array<{ kind: "text"; value: string }> = [],
		): Promise<unknown> => {
			const repositoryEndpoint = new URL(
				`/lix/v1/${repositoryId}/`,
				baseURL,
			).toString();
			const authorization = {
				Authorization: "Bearer lixray-demo",
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			};
			const opened = await sharedContext.request.get(repositoryEndpoint, {
				headers: authorization,
			});
			expect(opened.ok()).toBe(true);
			const { sessionId } = (await opened.json()) as { sessionId: string };
			try {
				const response = await sharedContext.request.post(
					new URL("execute", repositoryEndpoint).toString(),
					{
						headers: {
							...authorization,
							"Idempotency-Key": `checkpoint-read-${scenario}-${randomUUID()}-${authorityReadSequence++}`,
							"Lix-Session-Id": sessionId,
						},
						data: {
							sql,
							params,
						},
					},
				);
				expect(response.ok()).toBe(true);
				const result = (await response.json()) as {
					rows?: Array<Array<{ kind?: string; value?: unknown }>>;
				};
				const cell = result.rows?.[0]?.[0];
				if (!cell) throw new Error("authority returned no scalar value");
				return cell.value;
			} finally {
				const closed = await sharedContext.request.delete(
					new URL("session", repositoryEndpoint).toString(),
					{
						headers: {
							...authorization,
							"Lix-Session-Id": sessionId,
						},
					},
				);
				expect(closed.status()).toBe(204);
			}
		};
		const authorityCheckpointCount = async (): Promise<number> => {
			const count = await authorityScalar(
				"SELECT count(*) AS checkpoint_count FROM lix_log() WHERE is_checkpoint",
			);
			if (typeof count !== "number")
				throw new Error("authority returned an invalid checkpoint count");
			return count;
		};
		const authorityHead = async (): Promise<string> => {
			const head = await authorityScalar(
				"SELECT lix_active_branch_commit_id() AS commit_id",
			);
			if (typeof head !== "string")
				throw new Error("authority returned an invalid head");
			return head;
		};
		const replicaHead = async (page: Page): Promise<string> =>
			page.evaluate(async () => {
				const result = await (
					globalThis as typeof globalThis & {
						__lixSyncHead: () => Promise<{
							rows?: Array<Array<{ value?: unknown }>>;
						}>;
					}
				).__lixSyncHead();
				const head = result.rows?.[0]?.[0]?.value;
				if (typeof head !== "string")
					throw new Error(`Invalid local head: ${JSON.stringify(result)}`);
				return head;
			});

		const renderedCheckpointCount = async (
			history: Locator,
			expected: number,
		) => {
			const rows = history
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li");
			// History deliberately starts with ten rows. Expand its next page when
			// comparing the rendered timeline with the durable checkpoint count.
			if ((await rows.count()) < expected) {
				const older = history.getByRole("button", {
					name: "Load older checkpoints",
					exact: true,
				});
				if (await older.isVisible()) await older.click();
			}
			return rows.count();
		};
		const waitForHistoryCountsToMatchAuthority = async (
			histories: readonly Locator[],
			minimumCount: number,
			timeout: number,
		): Promise<number> => {
			let matchedCount = 0;
			await expect
				.poll(
					async () => {
						const authorityCount = await authorityCheckpointCount();
						const renderedCounts = await Promise.all(
							histories.map((history) =>
								renderedCheckpointCount(history, authorityCount),
							),
						);
						const matches =
							authorityCount >= minimumCount &&
							renderedCounts.every((count) => count === authorityCount);
						if (matches) matchedCount = authorityCount;
						return matches;
					},
					{ timeout },
				)
				.toBe(true);
			return matchedCount;
		};
		const openRepositoryWorkingChanges = async (page: Page) => {
			await page
				.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
				})
				.click();
			await expect(
				page.getByRole("button", { name: "Exit", exact: true }),
			).toBeVisible();
		};
		const clickCheckpoint = async (
			page: Page,
			selectFiles?: () => Promise<void>,
		): Promise<string> => {
			const historyBefore = await openHistoryPanel(right);
			// Opening the panel does not mean its asynchronous timeline is loaded.
			// Establish the server-backed baseline before going offline; otherwise
			// seeded checkpoints arriving later look like extra local checkpoints.
			const before = await waitForHistoryCountsToMatchAuthority(
				[historyBefore],
				0,
				repositoryOperationTimeout,
			);
			const localCount = before;
			const localCheckpointIds = new Set<string>();
			const captureCheckpoint = (request: Request) => {
				if (
					request.method() !== "POST" ||
					!request.url().endsWith("/sync/push")
				)
					return;
				const body = request.postDataJSON() as {
					refUpdates?: Array<{
						checkpointCommitId?: unknown;
						expectedCheckpointCommitId?: unknown;
					}>;
				};
				for (const update of body.refUpdates ?? []) {
					if (
						typeof update.checkpointCommitId === "string" &&
						update.checkpointCommitId !== update.expectedCheckpointCommitId
					) {
						localCheckpointIds.add(update.checkpointCommitId);
					}
				}
			};
			// Count/history preparation can yield while editor side effects commit.
			// Capture the review epoch only after that preparation has completed.
			await openRepositoryWorkingChanges(page);
			if (selectFiles) {
				await selectFiles();
			} else {
				// The primary action checkpoints the selection, not every file.
				const scope = page.getByRole("button", {
					name: /Working set: \d+ of \d+ files/,
				});
				if (await scope.count()) {
					await scope.click();
					const allFiles = page.getByRole("checkbox", {
						name: "All files",
						exact: true,
					});
					if ((await allFiles.getAttribute("aria-checked")) !== "true") {
						await allFiles.click();
					}
					await expect(allFiles).toHaveAttribute("aria-checked", "true");
				}
			}
			// Review presentation can load asynchronously. Finish that online setup
			// before measuring the local checkpoint with the network unavailable.
			const checkpointButton = page.getByRole("button", {
				name: "Checkpoint",
				exact: true,
			});
			await expect(checkpointButton).toBeVisible({ timeout: 30_000 });
			await expect(checkpointButton).toBeEnabled({ timeout: 30_000 });
			sharedContext.on("request", captureCheckpoint);
			offlineContexts.add(sharedContext);
			await sharedContext.setOffline(true);
			try {
				const checkpointDeadline = Date.now() + 5_000;
				await checkpointButton.click({ timeout: 5_000 });
				// The second tab observes the same durable OPFS commit while the
				// server is unreachable; no foreground /execute receipt is needed.
				const remainingCheckpointTime = checkpointDeadline - Date.now();
				expect(remainingCheckpointTime).toBeGreaterThan(0);
				await expect
					.poll(() => renderedCheckpointCount(historyBefore, localCount + 1), {
						timeout: remainingCheckpointTime,
					})
					.toBe(localCount + 1);
				if (selectFiles) {
					// A partial checkpoint leaves the remaining files in review.
					await expect(
						page.getByRole("button", { name: "Checkpointed", exact: true }),
					).toBeDisabled();
					await page.getByRole("button", { name: "Exit", exact: true }).click();
				} else {
					await expect(
						page.getByRole("button", { name: /^(Checkpoint|Checkpointing…)$/ }),
					).toHaveCount(0);
				}
			} finally {
				await sharedContext.setOffline(false);
				offlineContexts.delete(sharedContext);
			}
			try {
				await expect
					.poll(() => localCheckpointIds.size, {
						timeout: repositoryOperationTimeout,
					})
					.toBe(1);
			} finally {
				sharedContext.off("request", captureCheckpoint);
			}
			const [localCheckpointId] = localCheckpointIds;
			if (!localCheckpointId)
				throw new Error("local checkpoint upload omitted its identity");
			await expect
				.poll(authorityCheckpointCount, { timeout: repositoryOperationTimeout })
				.toBeGreaterThanOrEqual(before + 1);
			const endpoint = new URL(`/lix/v1/${repositoryId}/`, baseURL).toString();
			const authorization = {
				Authorization: "Bearer lixray-demo",
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			};
			const opened = await sharedContext.request.get(endpoint, {
				headers: authorization,
			});
			expect(opened.ok()).toBe(true);
			const { sessionId } = (await opened.json()) as { sessionId: string };
			try {
				// Verify this exact locally generated checkpoint was accepted. A
				// different writer increasing the catalog count cannot satisfy this.
				await expect
					.poll(
						async () => {
							const response = await sharedContext.request.post(
								new URL("execute", endpoint).toString(),
								{
									headers: {
										...authorization,
										"Lix-Session-Id": sessionId,
										"Idempotency-Key": `checkpoint-id-${scenario}-${randomUUID()}-${authorityReadSequence++}`,
									},
									data: {
										sql: "SELECT commit_id FROM lix_log() WHERE commit_id = $1 AND is_checkpoint",
										params: [{ kind: "text", value: localCheckpointId }],
									},
								},
							);
							expect(response.ok()).toBe(true);
							const result = (await response.json()) as {
								rows?: Array<Array<{ kind?: string; value?: unknown }>>;
							};
							return result.rows?.[0]?.[0]?.value;
						},
						{ timeout: repositoryOperationTimeout },
					)
					.toBe(localCheckpointId);
				return localCheckpointId;
			} finally {
				await sharedContext.request.delete(
					new URL("session", endpoint).toString(),
					{ headers: { ...authorization, "Lix-Session-Id": sessionId } },
				);
			}
		};
		const observePage = (page: Page, label: string) => {
			// Chromium can report a failed resource to the console after the
			// context has come back online. Correlate the console message with
			// a confirmed offline failure instead of sampling the current phase.
			const offlineConsoleRequests =
				createOfflineConsoleRequestTracker<Request>();
			const pageColdReads: string[] = [];
			coldReads.set(page, pageColdReads);
			const pagePendingColdReads = new Set<Request>();
			pendingColdReads.set(page, pagePendingColdReads);
			page.on("requestfinished", (request) =>
				pagePendingColdReads.delete(request),
			);
			page.on("requestfailed", (request) =>
				pagePendingColdReads.delete(request),
			);
			const pageBlobLaneRequests: string[] = [];
			blobLaneRequests.set(page, pageBlobLaneRequests);
			const pageBlobLanePayloadSizes: number[] = [];
			blobLanePayloadSizes.set(page, pageBlobLanePayloadSizes);
			page.on("request", (request) => {
				if (offlineContexts.has(page.context())) {
					offlineRequests.add(request);
				}
				if (
					(request.method() === "GET" &&
						/\/sync\/(history|blob|chunk)(?:\?|$)/.test(request.url())) ||
					(request.method() === "POST" &&
						/\/sync\/(native-objects|native-object-range|native-metadata)(?:\?|$)/.test(
							request.url(),
						))
				) {
					pageColdReads.push(request.url());
					pagePendingColdReads.add(request);
				}
				if (/\/sync\/(blob|chunk)(?:\?|$)/.test(request.url())) {
					pageBlobLaneRequests.push(`${request.method()} ${request.url()}`);
					pendingBlobLaneRequests.add(request);
					if (
						request.method() === "POST" &&
						/\/sync\/blob(?:\?|$)/.test(request.url())
					) {
						try {
							const manifest = request.postDataJSON() as unknown;
							if (
								typeof manifest !== "object" ||
								manifest === null ||
								!("sizeBytes" in manifest) ||
								typeof manifest.sizeBytes !== "number"
							) {
								blobLaneObservationFailures.push(
									`invalid POST blob manifest ${request.url()}`,
								);
							} else {
								pageBlobLanePayloadSizes.push(manifest.sizeBytes);
							}
						} catch (error) {
							blobLaneObservationFailures.push(
								`unreadable POST blob manifest ${request.url()}: ${String(error)}`,
							);
						}
					}
				}
			});
			page.on("requestfinished", (request) => {
				pendingBlobLaneRequests.delete(request);
				offlineConsoleRequests.finished(request);
			});
			page.on("pageerror", (error) => {
				runtimeFailures.push(`${label} pageerror: ${error.message}`);
			});
			page.on("console", (message) => {
				// Chromium mirrors an expected HTTP 409 response to the console without
				// exposing its URL. The response listener and exact-replay tracker below
				// retain unexpected or unrecovered sync failures for close().
				const expectedCasNoise =
					message.type() === "error" &&
					/Failed to load resource:.*status of 409/i.test(message.text());
				const expectedOfflineNoise =
					/ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED)/.test(
						message.text(),
					) &&
					(offlineConsoleRequests.consume(message.location().url) ||
						offlineContexts.has(page.context()));
				const transientPushNoise =
					(scenario === "editing" ||
						scenario === "history" ||
						scenario === "conflicts") &&
					message.type() === "error" &&
					/Failed to load resource:.*status of 503/i.test(message.text()) &&
					message.location().url.endsWith("/sync/push");
				if (transientPushNoise) {
					transientPushConsoleFailures.push({
						source: label,
						url: message.location().url,
						message: `${label} console: ${message.text()}`,
					});
				}
				if (
					message.type() === "error" &&
					!expectedCasNoise &&
					!expectedOfflineNoise &&
					!transientPushNoise
				) {
					runtimeFailures.push(`${label} console: ${message.text()}`);
				}
			});
			page.on("requestfailed", (request) => {
				pendingBlobLaneRequests.delete(request);
				const errorText = request.failure()?.errorText ?? "unknown";
				if (
					(offlineContexts.has(page.context()) ||
						offlineRequests.has(request)) &&
					/ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED)/.test(errorText)
				) {
					offlineConsoleRequests.failed(request);
					return;
				}
				if (/abort|cancel/i.test(errorText)) {
					unreadableBlobLaneResponses.delete(request);
				}
				if (request.url().includes("/lix/v1/")) {
					// Reconciliation cancels an obsolete in-flight long poll or push after
					// another request wins the ref CAS. Final convergence assertions prove
					// that the replacement request completed.
					if (/abort|cancel/i.test(errorText)) {
						return;
					}
					runtimeFailures.push(
						`${label} requestfailed: ${errorText} ${request.url()}`,
					);
				}
			});
			page.on("response", (response) => {
				const url = response.url();
				if (!/\/lix\/v1\/[^/]+\/sync\//.test(url)) return;
				const pushObservation = url.endsWith("/sync/push")
					? transientPushRecovery.observe({
							source: label,
							replicaId: response.request().headers()["lix-replica-id"] ?? null,
							method: response.request().method(),
							url,
							status: response.status(),
							body: response.request().postDataBuffer(),
						})
					: undefined;
				if (
					response.request().method() === "GET" &&
					/\/sync\/blob(?:\?|$)/.test(url) &&
					response.ok()
				) {
					const responseBody = response
						.json()
						.then((body: unknown) => {
							if (!Array.isArray(body)) return;
							for (const manifest of body as unknown[]) {
								if (
									typeof manifest === "object" &&
									manifest !== null &&
									"sizeBytes" in manifest &&
									typeof manifest.sizeBytes === "number"
								) {
									pageBlobLanePayloadSizes.push(manifest.sizeBytes);
								}
							}
						})
						.catch((error: unknown) => {
							const failureText = response.request().failure()?.errorText ?? "";
							if (/abort|cancel/i.test(failureText)) return;
							unreadableBlobLaneResponses.set(
								response.request(),
								`unreadable GET blob manifest ${url}: ${String(error)}`,
							);
						});
					pendingBlobLaneResponses.add(responseBody);
					void responseBody.finally(() => {
						pendingBlobLaneResponses.delete(responseBody);
					});
				}
				if (
					!(
						response.request().method() === "GET" &&
						/\/sync\/chunk(?:\?|$)/.test(url)
					) &&
					response.headers()["cache-control"] !== "no-store"
				) {
					syncFailures.push(`cacheable protocol response ${url}`);
				}
				const pendingRetainedBodyReplay =
					isRetainedBodyUpload(response.request().method(), url) &&
					retainedBodyRecovery.observe({
						method: response.request().method(),
						url,
						status: response.status(),
						body: response.request().postDataBuffer(),
					});
				const pendingMergeReplay = mergeReplay.observe({
					method: response.request().method(),
					url,
					status: response.status(),
					body: response.request().postDataBuffer(),
				});
				// Push has no idempotency key, so its only 409 mapping is the expected
				// ref-CAS race. Convergence below proves that reconciliation completed.
				if (
					response.status() >= 400 &&
					!pendingRetainedBodyReplay &&
					!(response.status() === 409 && url.endsWith("/sync/push"))
				) {
					const failure = `${response.status()} ${url}`;
					const failureRecorded = !pendingMergeReplay;
					if (
						failureRecorded &&
						(!pushObservation || pushObservation.status !== 503)
					)
						syncFailures.push(failure);
					if (failureRecorded && url.endsWith("/sync/push")) {
						const detail = response
							.text()
							.then((body) => {
								syncFailureDetails.push(`${failure}: ${body.slice(0, 2_000)}`);
								if (
									pushObservation?.status === 503 &&
									(scenario === "editing" ||
										scenario === "history" ||
										scenario === "conflicts")
								)
									transientPushRecovery.classify(pushObservation, body);
							})
							.catch((error: unknown) => {
								syncFailureDetails.push(
									`${failure}: unreadable response: ${String(error)}`,
								);
							});
						pendingSyncFailureDetails.add(detail);
						void detail.finally(() => pendingSyncFailureDetails.delete(detail));
					}
					if (
						response.status() === 409 &&
						response.request().method() === "POST" &&
						new URL(url).pathname.endsWith("/sync/merge")
					) {
						const classification = response
							.json()
							.then((body: unknown) => {
								const retryable = isRetryableMergeConflict(
									response.request().method(),
									url,
									response.status(),
									body,
								);
								mergeReplay.classifyConflict(
									{
										method: response.request().method(),
										url,
										status: response.status(),
										body: response.request().postDataBuffer(),
									},
									retryable,
								);
								if (!retryable) return;
								if (failureRecorded) {
									const index = syncFailures.indexOf(failure);
									if (index >= 0) syncFailures.splice(index, 1);
								}
								recoveredMergeConflicts.push(failure);
							})
							.catch(() => undefined);
						pendingMergeClassifications.add(classification);
						void classification.finally(() =>
							pendingMergeClassifications.delete(classification),
						);
					}
				}
			});
		};
		const coldReadCount = (pages: Page[]) =>
			pages.reduce(
				(count, page) => count + (coldReads.get(page)?.length ?? 0),
				0,
			);
		const waitForColdReadQuiescence = async (pages: Page[]) => {
			let lastCount = coldReadCount(pages);
			let stableSamples = 0;
			await expect
				.poll(
					() => {
						const currentCount = coldReadCount(pages);
						const pending = pages.some(
							(page) => (pendingColdReads.get(page)?.size ?? 0) > 0,
						);
						stableSamples =
							currentCount === lastCount && !pending ? stableSamples + 1 : 0;
						lastCount = currentCount;
						return stableSamples;
					},
					{ intervals: [500], timeout: 30_000 },
				)
				.toBeGreaterThanOrEqual(8);
		};
		const blobLaneRequestCount = (pages: Page[]) =>
			pages.reduce(
				(count, page) => count + (blobLaneRequests.get(page)?.length ?? 0),
				0,
			);
		const waitForBlobLaneQuiescence = async (pages: Page[]) => {
			let lastCount = blobLaneRequestCount(pages);
			let stableSamples = 0;
			await expect
				.poll(
					() => {
						const currentCount = blobLaneRequestCount(pages);
						stableSamples =
							currentCount === lastCount && pendingBlobLaneRequests.size === 0
								? stableSamples + 1
								: 0;
						lastCount = currentCount;
						return stableSamples;
					},
					{ intervals: [500], timeout: 30_000 },
				)
				.toBeGreaterThanOrEqual(8);
		};
		const settleBlobLaneResponses = async () => {
			while (pendingBlobLaneResponses.size > 0) {
				await Promise.all([...pendingBlobLaneResponses]);
			}
		};
		observePage(left, "left");
		observePage(right, "right");

		const openFiles = async (page: Page) => {
			await page.goto(repositoryUrl);
			await showLibraryFiles(page);
			await libraryFileIds(page);
		};
		/**
		 * Library's New menu is Atelier's, so its rows are named the way Atelier
		 * names them.
		 */
		const newMenuRow = (extension: "md" | "csv" | "excalidraw") =>
			`[data-attr="file-new-${extension === "md" ? "markdown" : extension}"]`;
		const createFileFromLibrary = async (
			page: Page,
			extension: "md" | "csv" | "excalidraw",
		): Promise<void> => {
			await openFiles(page);
			const homeUrl = page.url();
			await page.getByTestId("library-new").click();
			await page.locator(newMenuRow(extension)).click();
			await expect(page).not.toHaveURL(homeUrl, {
				timeout: repositoryOperationTimeout,
			});
		};
		const localFiles = async (page: Page) =>
			page.evaluate(async () => {
				const result = await (
					globalThis as typeof globalThis & {
						__lixSyncFiles: () => Promise<{
							rows: Array<Array<{ value: string }>>;
						}>;
					}
				).__lixSyncFiles();
				if (!result.rows)
					throw new Error(`Local file probe failed: ${JSON.stringify(result)}`);
				return result;
			});
		const libraryFileIds = async (page: Page) => {
			const visiblePaths = await page
				.getByTestId("library-file-row")
				.evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-path")),
				);
			// Read identities from this browser's replica, never from the authority.
			// Library rows expose paths; later partial-checkpoint assertions need IDs.
			const result = await localFiles(page);
			return result.rows
				.filter((row) => visiblePaths.includes(row[1]!.value))
				.map((row) => row[0]!.value)
				.sort();
		};
		const libraryFileEntry = async (page: Page, fileId: string) => {
			let path: string | undefined;
			await expect
				.poll(
					async () => {
						const result = await localFiles(page);
						path = result.rows.find((row) => row[0]!.value === fileId)?.[1]!
							.value;
						return path;
					},
					{ timeout: repositoryOperationTimeout },
				)
				.toBeDefined();
			return page
				.getByTestId("library-file-row")
				.and(page.locator(`[data-path=${JSON.stringify(path)}]`))
				.locator("button[draggable]");
		};
		const waitForRepositoryFiles = showLibraryFiles;
		const waitForNewLibraryFileIds = async (
			page: Page,
			previousIds: readonly string[],
			expectedCount: number,
			timeout: number,
		): Promise<string[]> => {
			const previous = new Set(previousIds);
			let addedIds: string[] = [];
			await expect
				.poll(
					async () => {
						addedIds = (await libraryFileIds(page)).filter(
							(id) => !previous.has(id),
						);
						return addedIds.length;
					},
					{ timeout },
				)
				.toBe(expectedCount);
			return addedIds;
		};

		async function navigation() {
			await test.step("every preview repository opens through every entry point", async () => {
				await left.goto(new URL("/home", baseURL).toString());
				await expect(left.getByTestId("repository-directory")).toBeVisible();
				const repositories = await left
					.getByTestId("repository-link")
					.evaluateAll((links) =>
						links.map((link) => ({
							id: link.getAttribute("data-repository-id"),
							href: (link as HTMLAnchorElement).href,
						})),
					);
				expect(repositories.length).toBeGreaterThanOrEqual(2);
				expect(repositories.every(({ id, href }) => id && href)).toBe(true);
				const repositoryIds = repositories.map(({ id }) => id!);
				expect(new Set(repositoryIds).size).toBe(repositoryIds.length);
				expect(repositoryIds).toContain(repositoryId);

				for (const repository of repositories) {
					await left.goto(new URL("/home", baseURL).toString());
					await expect(left.getByTestId("repository-directory")).toBeVisible();
					await left
						.getByTestId("repository-link")
						.and(left.locator(`[data-repository-id="${repository.id!}"]`))
						.click();
					await waitForRepositoryFiles(left);
					await expect(left.getByTestId("repository-picker")).toHaveAttribute(
						"data-repository-id",
						repository.id!,
					);

					// Exercise the shareable direct URL independently from the directory link.
					await left.goto(repository.href);
					await waitForRepositoryFiles(left);
					await expect(left.getByTestId("repository-picker")).toHaveAttribute(
						"data-repository-id",
						repository.id!,
					);
					await left.getByTestId("repository-picker").click();
					const pickerIds = await left
						.getByTestId("repository-picker-item")
						.evaluateAll((items) =>
							items
								.map((item) => item.getAttribute("data-repository-id"))
								.filter((id): id is string => id !== null)
								.sort(),
						);
					expect(pickerIds).toEqual([...repositoryIds].sort());
					await left.keyboard.press("Escape");

					const repositoryPath = new URL(repository.href).pathname.replace(
						/\/$/,
						"",
					);
					await left.goto(
						new URL(`${repositoryPath}/team`, baseURL).toString(),
					);
					await expect(left.getByTestId("repository-people-view")).toBeVisible({
						timeout: repositoryOperationTimeout,
					});
					await left.goto(
						new URL(`${repositoryPath}/settings`, baseURL).toString(),
					);
					await expect(
						left.getByTestId("repository-settings-view"),
					).toBeVisible({
						timeout: repositoryOperationTimeout,
					});
					await left.goto(new URL(`${repositoryPath}/sql`, baseURL).toString());
					await expect(
						left.locator('[data-view-key="sql_explorer"]').first(),
					).toBeVisible({ timeout: repositoryOperationTimeout });
				}

				// Switch through the real picker, including back to the first repository,
				// and prove /open restores each selected repository after a navigation.
				await left.goto(repositories[0]!.href);
				await waitForRepositoryFiles(left);
				for (const repository of [...repositories.slice(1), repositories[0]!]) {
					await left.getByTestId("repository-picker").click();
					await left
						.getByTestId("repository-picker-item")
						.and(left.locator(`[data-repository-id="${repository.id!}"]`))
						.click();
					await waitForRepositoryFiles(left);
					await expect(left.getByTestId("repository-picker")).toHaveAttribute(
						"data-repository-id",
						repository.id!,
					);
					await left.goto(new URL("/open", baseURL).toString());
					await waitForRepositoryFiles(left);
					await expect(left.getByTestId("repository-picker")).toHaveAttribute(
						"data-repository-id",
						repository.id!,
					);
				}
				await test.info().attach("preview-repositories.json", {
					body: JSON.stringify(repositories, null, 2),
					contentType: "application/json",
				});
			});
		}
		async function checkpointConversation() {
			if (!describedCheckpoint) throw new Error("Requires the history fixture");
			// Use a separate browser profile: neither OPFS nor native metadata has
			// been installed by another app view before this SQL query runs.
			const context = await newContext();
			contexts.push(context);
			const page = await newPage(context);
			await page.goto(`${repositoryUrl}/sql`);
			const editor = page.getByRole("textbox", { name: "SQL query" });
			await expect(editor).toBeVisible({ timeout: repositoryOperationTimeout });
			await editor.fill(
				`SELECT conversation_id FROM lix_log() WHERE commit_id = '${describedCheckpoint.commitId}'`,
			);
			await page.locator('[data-attr="sql-run-query"]').click();
			await expect(page.locator('[data-attr="sql-run-status"]')).toContainText(
				"1 row",
				{ timeout: repositoryOperationTimeout },
			);
			expect(await page.getByRole("cell").allTextContents()).toEqual([
				describedCheckpoint.conversationId,
			]);
			await context.close();
		}
		async function editing() {
			await Promise.all([openFiles(left), openFiles(right)]);
			const lockState = await left.evaluate(async () => {
				const snapshot = await navigator.locks.query();
				return {
					held: snapshot.held?.map((lock) => lock.name) ?? [],
					pending: snapshot.pending?.map((lock) => lock.name) ?? [],
				};
			});
			const opfsWriterLocks = [...lockState.held, ...lockState.pending].filter(
				(name) => name?.startsWith("lix:opfs-sqlite:"),
			);
			expect(new Set(opfsWriterLocks).size).toBe(1);
			expect(
				[...lockState.held, ...lockState.pending].some((name) =>
					name?.startsWith("lixray:opfs-replica:"),
				),
			).toBe(false);

			if ((await libraryFileIds(left)).length === 0) {
				await createFileFromLibrary(left, "md");
				await expect
					.poll(() => libraryFileIds(right), {
						timeout: repositoryOperationTimeout,
					})
					.not.toEqual([]);
				await Promise.all([openFiles(left), openFiles(right)]);
			}
			await Promise.all([
				left.getByTestId("library-rows").waitFor({ timeout: 120_000 }),
				right.getByTestId("library-rows").waitFor({ timeout: 120_000 }),
			]);
			const initialLeftHistory = await openHistoryPanel(left);
			const initialCheckpointCount = await waitForHistoryCountsToMatchAuthority(
				[initialLeftHistory],
				0,
				repositoryOperationTimeout,
			);
			if (local) expect(initialCheckpointCount).toBeGreaterThan(1);
			{
				expect(initialCheckpointCount).toBeGreaterThanOrEqual(2);
				// A historical snapshot read must not monopolize the live repository
				// after its view closes. Exit immediately, while cold content may still
				// be loading, then prove the same client can create a checkpoint below.
				// Select an older checkpoint instead of "Latest checkpoint": this preview
				// repository persists across CI reruns and may already have working changes,
				// in which case selecting the latest checkpoint is intentionally a no-op.
				await initialLeftHistory
					.getByRole("list", { name: "Checkpoints" })
					.locator(":scope > li")
					.nth(1)
					.locator('[data-attr="history-view-checkpoint"]')
					.click();
				const exitHistory = left.getByRole("button", { name: "Exit" });
				await expect(exitHistory).toBeVisible({
					timeout: repositoryOperationTimeout,
				});
				await exitHistory.click();
				await expect(exitHistory).not.toBeVisible();
				// Closing review restores a prior tab (including SQL from the entry
				// tour). Keep the receiving client's live Files section open for discovery.
				await showLibraryFiles(left);
				await expect(left.getByTestId("library-rows")).toBeVisible();
			}
			// Let bootstrap and historical-view hydration finish before attributing
			// any later blob payload to realtime work.
			await waitForBlobLaneQuiescence([left, right]);
			await settleBlobLaneResponses();
			expect(blobLaneObservationFailures).toEqual([]);
			expect([...unreadableBlobLaneResponses.values()]).toEqual([]);
			test.info().annotations.push({
				type: "bootstrap-blob-manifests",
				description: JSON.stringify({
					requests: blobLaneRequestCount([left, right]),
					manifests: [...blobLanePayloadSizes.values()].flat().length,
				}),
			});
			const blobPayloadCountsBeforeEmptyFile = new Map(
				[left, right].map((page) => [
					page,
					blobLanePayloadSizes.get(page)?.length ?? 0,
				]),
			);

			// Returning from a historical view restores Library asynchronously. Its shell
			// can be visible before the live file rows have arrived. Establish the
			// same nonempty baseline in both tabs before measuring one new file.
			await expect
				.poll(async () => (await libraryFileIds(right)).length)
				.toBeGreaterThan(0);
			await expect
				.poll(() => libraryFileIds(left))
				.toEqual(await libraryFileIds(right));
			const fileIdsBeforeCreatedFile = await libraryFileIds(left);
			await right.getByTestId("library-new").click();
			await right.locator(newMenuRow("md")).click();
			const rightEditor = right.locator(
				'.ProseMirror[contenteditable="true"]:visible',
			);
			await rightEditor.waitFor({ timeout: 30_000 });
			const createdUrl = right.url();
			const [createdFileId] = await waitForNewLibraryFileIds(
				left,
				fileIdsBeforeCreatedFile,
				1,
				realtimeTimeout,
			);
			await expect(await libraryFileEntry(left, createdFileId!)).toBeVisible();
			await waitForBlobLaneQuiescence([left, right]);
			await settleBlobLaneResponses();
			expect(blobLaneObservationFailures).toEqual([]);
			expect([...unreadableBlobLaneResponses.values()]).toEqual([]);
			const newBlobPayloadSizes = [left, right].flatMap((page) =>
				(blobLanePayloadSizes.get(page) ?? []).slice(
					blobPayloadCountsBeforeEmptyFile.get(page) ?? 0,
				),
			);
			// Attribute the transport assertion to the empty payload itself. A global
			// request count also includes delayed hydration for unrelated older files.
			expect(newBlobPayloadSizes).not.toContain(0);
			await left.goto(createdUrl);
			const leftEditor = left.locator(
				'.ProseMirror[contenteditable="true"]:visible',
			);
			// File discovery and a cold editor open are separate from the realtime
			// interaction budget. Qualify both first so the assertions below measure
			// two already-open clients, not extension startup or demand hydration.
			await leftEditor.waitFor({ timeout: 30_000 });

			// Progressive views can render before unrelated native/history hydration
			// settles. Qualify all measured download lanes after this page mount,
			// then retain the zero-download budget for the actual warm edit.
			await waitForColdReadQuiescence([left, right]);
			// Warm typing must not download inputs; background blob uploads are allowed.
			const coldReadsBeforeRightEdit = coldReadCount([left, right]);
			const rightMarker = `right-${Date.now()}`;
			await rightEditor.click();
			await right.keyboard.insertText(rightMarker);
			// Keep ordinary typing focused. This qualifies the editor's debounce and
			// outbox path without relying on a blur/focus transition to publish it.
			await expect(rightEditor).toBeFocused();
			await expect(leftEditor).toContainText(rightMarker, {
				timeout: realtimeTimeout,
			});
			expect(coldReadCount([left, right])).toBe(coldReadsBeforeRightEdit);
			// The first heading also derives the filename in a debounced commit.
			// Settle that descriptor before later edits open a pinned working review.
			for (const page of [left, right]) {
				await expect(
					page
						.locator('[data-attr="panel-tab-select"]')
						.filter({ hasText: new RegExp(`^${rightMarker}\\.md$`) }),
				).toBeVisible({ timeout: realtimeTimeout });
			}

			const freshBootstrap =
				await test.step("fresh/incognito bootstrap renders hot History", async () => {
					// A context created only after the write exercises snapshot bootstrap,
					// as an incognito window does. Qualify History before later realtime
					// assertions so a collaboration failure cannot mask this result.
					const freshContext = await newContext();
					contexts.push(freshContext);
					const fresh = await newPage(freshContext);
					observePage(fresh, "fresh");
					await openFiles(fresh);
					await expect(
						await libraryFileEntry(fresh, createdFileId!),
					).toBeVisible({
						timeout: 120_000,
					});
					const coldReadsBeforeFreshHistory = coldReadCount([fresh]);
					const freshHistory = await openHistoryPanel(fresh);
					await expect(
						freshHistory.getByRole("button", { name: "Working changes" }),
					).toBeVisible();
					await waitForHistoryCountsToMatchAuthority(
						[freshHistory],
						initialCheckpointCount,
						repositoryOperationTimeout,
					);
					{
						await expect(freshHistory).toContainText(
							describedCheckpoint?.title ?? "Latest checkpoint",
						);
					}
					{
						await expect(freshHistory).toContainText("Initial checkpoint");
					}
					await expect(
						fresh.locator("[data-atelier-extension-suspended]"),
					).toHaveCount(0);
					// Working changes use the engine's hot authority. Keep a bounded
					// allowance for historical checkpoint metadata on a fresh replica.
					if (scenario === "performance") {
						expect(coldReadCount([fresh])).toBeLessThanOrEqual(
							coldReadsBeforeFreshHistory + 2,
						);
					}

					return { freshContext, fresh };
				});
			const { fresh } = freshBootstrap;
			const { freshContext } = freshBootstrap;

			// Keep the originating editor warm for the reverse direction. Reload and
			// OPFS-resume behavior is qualified independently below; coupling it to the
			// realtime budget made this assertion measure startup contention.
			await waitForColdReadQuiescence([left, right]);
			const coldReadsBeforeLeftEdit = coldReadCount([left, right]);
			const leftMarker = `left-${Date.now()}`;
			await leftEditor.click();
			// Keep the reverse-direction edit in the body so it does not schedule
			// another heading-derived filename mutation during checkpoint review.
			await left.keyboard.press("Control+End");
			await left.keyboard.press("Enter");
			await left.keyboard.insertText(leftMarker);
			await left.keyboard.press("Tab");
			await expect(rightEditor).toContainText(leftMarker, {
				timeout: realtimeTimeout,
			});
			expect(coldReadCount([left, right])).toBe(coldReadsBeforeLeftEdit);
			for (const page of [left, right]) {
				await expect(
					page.getByRole("button", {
						name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
					}),
				).toBeVisible({ timeout: 30_000 });
			}

			return {
				createdFileId: createdFileId!,
				createdUrl,
				leftEditor,
				rightEditor,
				fresh,
				freshContext,
				initialCheckpointCount,
			};
		}
		type EditingState = Awaited<ReturnType<typeof editing>>;
		async function independentConflicts(state: EditingState) {
			const {
				createdFileId,
				createdUrl,
				leftEditor,
				rightEditor,
				fresh,
				freshContext,
			} = state;
			expect(freshContext).not.toBe(sharedContext);
			const mirror = await newPage(freshContext);
			observePage(mirror, "independent-mirror");
			await Promise.all([fresh.goto(createdUrl), mirror.goto(createdUrl)]);
			const editor = (page: Page) =>
				page.locator('.ProseMirror[contenteditable="true"]:visible');
			const editors = [leftEditor, rightEditor, editor(fresh), editor(mirror)];
			const baseline = await leftEditor.locator("p").last().innerText();
			for (const view of editors) {
				await expect(view.locator("p").last()).toHaveText(baseline, {
					timeout: realtimeTimeout,
				});
			}

			const endpoint = new URL(`/lix/v1/${repositoryId}/`, baseURL).toString();
			const authorization = {
				Authorization: "Bearer lixray-demo",
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			};
			const opened = await sharedContext.request.get(endpoint, {
				headers: authorization,
			});
			expect(opened.ok()).toBe(true);
			const { sessionId } = (await opened.json()) as { sessionId: string };
			const headers = { ...authorization, "Lix-Session-Id": sessionId };
			const authorityContent = async () => {
				const response = await sharedContext.request.post(
					new URL("execute", endpoint).toString(),
					{
						headers: {
							...headers,
							"Idempotency-Key": `conflict-read-${randomUUID()}`,
						},
						data: {
							sql: "SELECT content FROM lix_file WHERE id = $1",
							params: [{ kind: "text", value: createdFileId }],
						},
					},
				);
				expect(response.ok(), await response.text()).toBe(true);
				const result = (await response.json()) as {
					rows: Array<Array<{ kind: string; base64?: string }>>;
				};
				const value = result.rows[0]?.[0];
				expect(value?.kind).toBe("blob");
				expect(typeof value?.base64).toBe("string");
				return Buffer.from(value!.base64!, "base64").toString("utf8");
			};
			const replicas = [
				{
					context: sharedContext,
					page: left,
					view: leftEditor,
					mirror: rightEditor,
				},
				{
					context: freshContext,
					page: fresh,
					view: editor(fresh),
					mirror: editor(mirror),
				},
			];
			let primaryFailure = false;
			let cleanupFailure: PromiseRejectedResult | undefined;
			try {
				for (const first of [0, 1]) {
					const last = 1 - first;
					const markers = [0, 1].map(
						(index) => `independent-${first}-${index}-${randomUUID()}`,
					);
					for (const { context } of replicas) offlineContexts.add(context);
					await Promise.all(
						replicas.map(({ context }) => context.setOffline(true)),
					);
					await Promise.all(
						replicas.map(async ({ view }, index) => {
							// Replace this paragraph as one input action. Separate Home /
							// Shift+End events depend on a transient selection.
							const paragraph = view.locator("p").last();
							await paragraph.fill(markers[index]!);
							await expect(paragraph).toHaveText(markers[index]!);
						}),
					);
					// The other tab in each profile proves durable local publication,
					// rather than merely observing the writer's unsaved editor draft.
					for (const [index, replica] of replicas.entries()) {
						await expect(replica.mirror.locator("p").last()).toHaveText(
							markers[index]!,
							{ timeout: 5_000 },
						);
					}
					await replicas[first]!.context.setOffline(false);
					offlineContexts.delete(replicas[first]!.context);
					await expect
						.poll(authorityContent, { timeout: realtimeTimeout })
						.toContain(markers[first]!);
					await expect(replicas[last]!.view.locator("p").last()).toHaveText(
						markers[last]!,
					);
					await replicas[last]!.context.setOffline(false);
					offlineContexts.delete(replicas[last]!.context);
					await expect
						.poll(authorityContent, { timeout: realtimeTimeout })
						.toContain(markers[last]!);
					for (const view of editors) {
						await expect(view.locator("p").last()).toHaveText(markers[last]!, {
							timeout: realtimeTimeout,
						});
					}
					expect(await authorityContent()).not.toContain(markers[first]!);
				}
			} catch (error) {
				primaryFailure = true;
				await test.info().attach("offline-conflict-diagnostics.json", {
					body: JSON.stringify(
						await Promise.allSettled(
							[left, right, fresh, mirror].map(collectSyncDiagnostics),
						),
						null,
						2,
					),
					contentType: "application/json",
				});
				throw error;
			} finally {
				const cleanup = await Promise.allSettled([
					...replicas.map(({ context }) => context.setOffline(false)),
					sharedContext.request.delete(
						new URL("session", endpoint).toString(),
						{ headers },
					),
				]);
				for (const { context } of replicas) offlineContexts.delete(context);
				for (const result of cleanup) {
					if (result.status !== "rejected") continue;
					if (!primaryFailure) cleanupFailure ??= result;
					test.info().annotations.push({
						type: "cleanup-error",
						description: String(result.reason),
					});
				}
			}
			if (cleanupFailure) throw cleanupFailure.reason;
		}
		async function continuousIndependentEdits(state: EditingState) {
			const pages = [left, state.fresh];
			await Promise.all(pages.map((page) => page.goto(state.createdUrl)));
			const editors = pages.map((page) =>
				page.locator('.ProseMirror[contenteditable="true"]:visible'),
			);
			for (const editor of editors) await expect(editor).toBeVisible();
			await expect
				.poll(async () => await editors[1]!.innerText(), {
					timeout: realtimeTimeout,
				})
				.toBe(await editors[0]!.innerText());
			// Keep the authority moving while the other independent replica recovers
			// from a stale push. Waiting for convergence after each edit hides this race.
			for (let round = 0; round < 12; round++) {
				const index = round % 2;
				await editors[index]!.click();
				await pages[index]!.keyboard.press("Control+End");
				await pages[index]!.keyboard.insertText(` online-${index}-${round}`);
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			await expect
				.poll(
					async () => {
						const values = await Promise.all(
							editors.map((editor) => editor.innerText()),
						);
						return values[0] === values[1];
					},
					{ timeout: 30_000 },
				)
				.toBe(true);
			// Equality alone can pass before pending uploads settle. Require a later
			// unique edit from each writer to reach its peer, with both editors open.
			for (let index = 0; index < 2; index++) {
				const marker = ` recovered-${index}-${randomUUID()}`;
				await editors[index]!.click();
				await pages[index]!.keyboard.press("Control+End");
				await pages[index]!.keyboard.insertText(marker);
				await expect(editors[1 - index]!).toContainText(marker, {
					timeout: 30_000,
				});
			}
		}
		async function staleReopen(state: EditingState) {
			const { freshContext, createdUrl } = state;
			let fresh = state.fresh;
			const before = await authorityHead();
			await expect
				.poll(() => replicaHead(fresh), { timeout: 30_000 })
				.toBe(before);
			await freshContext.setOffline(true);
			offlineContexts.add(freshContext);
			try {
				const marker = ` stale-reopen-${randomUUID()}`;
				await state.leftEditor.click();
				await left.keyboard.press("Control+End");
				await left.keyboard.insertText(marker);
				await expect
					.poll(
						() =>
							authorityScalar(
								"SELECT CAST(content AS TEXT) FROM lix_file WHERE id = $1",
								[{ kind: "text", value: state.createdFileId }],
							),
						{ timeout: 30_000 },
					)
					.toContain(marker);
				await expect.poll(authorityHead, { timeout: 30_000 }).not.toBe(before);
				expect(await replicaHead(fresh)).toBe(before);
				await fresh.close();
				await freshContext.setOffline(false);
				offlineContexts.delete(freshContext);
				fresh = await newPage(freshContext);
				observePage(fresh, "stale-reopen");
				await fresh.goto(createdUrl);
				await expect(
					fresh.locator('.ProseMirror[contenteditable="true"]:visible'),
				).toContainText(marker, { timeout: 30_000 });
				const after = await authorityHead();
				await expect
					.poll(() => replicaHead(fresh), { timeout: 30_000 })
					.toBe(after);
				await test.info().attach("stale-reopen.json", {
					body: JSON.stringify({
						before,
						after,
						coldReads: coldReads.get(fresh) ?? [],
					}),
					contentType: "application/json",
				});
			} finally {
				await freshContext.setOffline(false);
				offlineContexts.delete(freshContext);
			}
		}

		async function checkpoint(state: EditingState) {
			const { fresh, leftEditor, rightEditor } = state;

			const checkpointCountBeforeFirstClick = await authorityCheckpointCount();
			const firstCheckpointCommitId = await clickCheckpoint(left);
			const leftHistoryAfterCheckpoint = await openHistoryPanel(left);
			// A Playwright click resolves after dispatch, while the authoritative
			// checkpoint transaction can still be committing. Compare every rendered
			// History against the authority; this shared preview can receive legitimate
			// checkpoints from another client while the test is running.
			const rightHistoryAfterCheckpoint = await openHistoryPanel(right);
			const freshHistoryAfterCheckpoint = await openHistoryPanel(fresh);
			await waitForHistoryCountsToMatchAuthority(
				[
					leftHistoryAfterCheckpoint,
					rightHistoryAfterCheckpoint,
					freshHistoryAfterCheckpoint,
				],
				checkpointCountBeforeFirstClick + 1,
				repositoryOperationTimeout,
			);

			// The checkpoint coordinate is part of branch state. A later remote edit
			// must advance the receiver's head without silently advancing its checkpoint.
			const afterCheckpointMarker = `after-checkpoint-${Date.now()}`;
			await rightEditor.click();
			await right.keyboard.press("End");
			await right.keyboard.insertText(afterCheckpointMarker);
			await right.keyboard.press("Tab");
			await expect(leftEditor).toContainText(afterCheckpointMarker, {
				timeout: realtimeTimeout,
			});
			await expect(
				left.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
				}),
			).toBeVisible({ timeout: realtimeTimeout });

			return {
				...state,
				checkpointCountBeforeFirstClick,
				firstCheckpointCommitId,
			};
		}
		async function concurrent<T extends EditingState>(state: T) {
			const { fresh } = state;

			// Both tabs share one OPFS writer, so concurrent UI actions serialize
			// into one local commit chain and both reach the independent replica.
			const fileIdsBeforeConcurrentCreates = await libraryFileIds(fresh);
			await Promise.all([
				createFileFromLibrary(left, "md"),
				createFileFromLibrary(right, "csv"),
			]);
			const concurrentFileIds = await waitForNewLibraryFileIds(
				fresh,
				fileIdsBeforeConcurrentCreates,
				2,
				30_000,
			);
			// Keep both writers alive until the background upload reaches the
			// independent replica; reopen durability is exercised separately below.
			await Promise.all([openFiles(left), openFiles(right)]);
			for (const page of [left, right]) {
				for (const fileId of concurrentFileIds) {
					await expect(await libraryFileEntry(page, fileId)).toBeVisible({
						timeout: 30_000,
					});
				}
				await expect(
					page.getByRole("button", {
						name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
					}),
				).toBeVisible({ timeout: 30_000 });
			}

			// The already-qualified incognito client must stay live through a stale
			// push reconciliation; do not hide this behind a second cold bootstrap.
			const mountedConcurrentViewKinds = new Set<string>();
			for (const fileId of concurrentFileIds) {
				await expect(await libraryFileEntry(fresh, fileId)).toBeVisible({
					timeout: 30_000,
				});
				const homeUrl = fresh.url();
				await (await libraryFileEntry(fresh, fileId)).click();
				await expect(fresh).not.toHaveURL(homeUrl, {
					timeout: repositoryOperationTimeout,
				});
				const mountedView = fresh.locator(
					`[data-testid="atelier-view:atelier_file:${fileId}"][data-active="true"], [data-testid="atelier-view:atelier_csv:${fileId}"][data-active="true"]`,
				);
				await expect(mountedView).toBeVisible({
					timeout: repositoryOperationTimeout,
				});
				const mountedViewTestId = await mountedView.getAttribute("data-testid");
				expect(mountedViewTestId).toBeTruthy();
				mountedConcurrentViewKinds.add(mountedViewTestId!.split(":")[1]!);
				await openFiles(fresh);
				await expect(await libraryFileEntry(fresh, fileId)).toBeVisible({
					timeout: repositoryOperationTimeout,
				});
			}
			expect([...mountedConcurrentViewKinds].sort()).toEqual([
				"atelier_csv",
				"atelier_file",
			]);
			await expect(
				fresh.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
				}),
			).toBeVisible({ timeout: 30_000 });

			return { ...state, concurrentFileIds };
		}
		async function reopen<T extends EditingState>(state: T) {
			let { fresh } = state;
			const { freshContext, createdFileId } = state;

			// Close the only tab, then create a new top-level browsing context in the
			// same browser profile. This is the real warm-reopen case: sessionStorage is
			// gone, while localStorage and OPFS survive. The Web Lock released by unload
			// lets the new document reclaim the exact same mutable replica safely.
			const freshReplicaEntries = await fresh.evaluate(() =>
				Object.entries(localStorage).filter(([key]) =>
					key.startsWith("lixray:browser-replica:v3:"),
				),
			);
			expect(freshReplicaEntries).toHaveLength(1);
			// Warm reuse requires a synchronized durable replica. The final edit in
			// editing() is confirmed by the writers, but fresh can still be behind.
			// Observe only the hot branch coordinate; do not prefetch any payload.
			let warmBaselineHead: string | undefined;
			if (scenario === "performance") {
				warmBaselineHead = await authorityHead();
				await expect
					.poll(() => replicaHead(fresh), { timeout: 30_000 })
					.toBe(warmBaselineHead);
				await waitForColdReadQuiescence([fresh]);
				expect(await authorityHead()).toBe(warmBaselineHead);
				expect(await replicaHead(fresh)).toBe(warmBaselineHead);
				await test.info().attach("warm-reopen-baseline.json", {
					body: JSON.stringify({
						head: warmBaselineHead,
						coldReadCount: coldReadCount([fresh]),
					}),
					contentType: "application/json",
				});
			}

			const warmReopenUsableSamplesMs: number[] = [];
			const warmReopenColdReads: string[][] = [];
			const warmReopenProfiles: Array<{
				phases: Array<{ name: string; startTime: number }>;
				startupUiHookQueryCensus: {
					atelierObserve: number;
					atelierExecute: number;
					lixrayObserve: number;
				};
			}> = [];
			for (
				let sample = 0;
				sample < (scenario === "performance" ? 5 : 1);
				sample += 1
			) {
				await fresh.close();
				fresh = await newPage(freshContext);
				observePage(fresh, `fresh-reopen-${sample + 1}`);
				const reopenStartedAt = Date.now();
				await fresh.goto(repositoryUrl, { waitUntil: "domcontentloaded" });
				await showLibraryFiles(fresh);
				await libraryFileIds(fresh);
				await expect(await libraryFileEntry(fresh, createdFileId!)).toBeVisible(
					{
						timeout: 30_000,
					},
				);
				const sampleColdReads = [...(coldReads.get(fresh) ?? [])];
				warmReopenColdReads.push(sampleColdReads);
				warmReopenUsableSamplesMs.push(Date.now() - reopenStartedAt);
				if (warmBaselineHead)
					expect(await replicaHead(fresh)).toBe(warmBaselineHead);
				// Keep durability verification outside the usable-time sample. This
				// Playwright RPC validates identity continuity but is not app startup.
				expect(
					await fresh.evaluate(() =>
						Object.entries(localStorage).filter(([key]) =>
							key.startsWith("lixray:browser-replica:v3:"),
						),
					),
				).toEqual(freshReplicaEntries);
				warmReopenProfiles.push(
					await fresh.evaluate(() => {
						const phases = performance
							.getEntriesByType("mark")
							.filter((entry) =>
								entry.name.startsWith("lixray:repository-open:"),
							)
							.map((entry) => ({
								name: entry.name,
								startTime: Math.round(entry.startTime),
							}));
						const treeReady = performance.getEntriesByName(
							"lixray:repository-open:tree-ready",
						)[0]?.startTime;
						const countBeforeTreeReady = (name: string) =>
							performance
								.getEntriesByName(name)
								.filter(
									(entry) =>
										treeReady !== undefined && entry.startTime <= treeReady,
								).length;
						return {
							phases,
							startupUiHookQueryCensus: {
								atelierObserve: countBeforeTreeReady("atelier:query:observe"),
								atelierExecute: countBeforeTreeReady("atelier:query:execute"),
								lixrayObserve: countBeforeTreeReady("lixray:query:observe"),
							},
						};
					}),
				);
			}
			if (scenario === "performance") {
				const warmReopenPhases = warmReopenProfiles[0]!.phases;
				const startupUiHookQueryCensus =
					warmReopenProfiles[0]!.startupUiHookQueryCensus;
				const startupUiHookQueryBudget = {
					atelierObserve: 3,
					atelierExecute: 0,
					lixrayObserve: 2,
				};
				const phaseNames = [
					"lixray:repository-open:start",
					"lixray:repository-open:replica-identified",
					"lixray:repository-open:lix-opened",
					"lixray:repository-open:branch-ready",
					"lixray:repository-open:session-ready",
					"lixray:repository-open:atelier-ready",
					"lixray:repository-open:tree-ready",
				];
				const sortedSamples = [...warmReopenUsableSamplesMs].sort(
					(leftSample, rightSample) => leftSample - rightSample,
				);
				const medianWarmReopenUsableMs =
					sortedSamples[Math.floor(sortedSamples.length / 2)]!;
				const warmReopenP90UsableMs =
					sortedSamples[Math.ceil(sortedSamples.length * 0.9) - 1]!;
				// This is a hosted regression ceiling, not the product latency target.
				// The causal phase/query assertions below identify where time is spent;
				// this bound prevents a locally cached reopen from silently taking tens
				// of seconds while remaining tolerant of shared CI runner variance.
				const warmReopenP90CeilingMs = 10_000;
				const profilePath = test.info().outputPath("warm-reopen-profile.json");
				await writeFile(
					profilePath,
					JSON.stringify(
						{
							warmBaselineHead,
							warmReopenUsableSamplesMs,
							warmReopenColdReads,
							medianWarmReopenUsableMs,
							warmReopenP90UsableMs,
							warmReopenP90CeilingMs,
							warmReopenProfiles,
							phasesFromNavigationStartMs: Object.fromEntries(
								warmReopenPhases.map((phase) => [phase.name, phase.startTime]),
							),
							startupUiHookQueryCensus,
							startupUiHookQueryBudget,
						},
						null,
						2,
					),
				);
				await test.info().attach("warm-reopen-profile.json", {
					path: profilePath,
					contentType: "application/json",
				});
				expect(
					warmReopenP90UsableMs,
					"warm OPFS reopen p90 exceeded the hosted regression ceiling",
				).toBeLessThanOrEqual(warmReopenP90CeilingMs);
				for (const sampleColdReads of warmReopenColdReads) {
					expect(
						sampleColdReads,
						"a warm OPFS reopen must not request history or blob payloads before usable",
					).toEqual([]);
				}
				for (const profile of warmReopenProfiles) {
					expect(
						profile.startupUiHookQueryCensus.atelierObserve,
					).toBeGreaterThan(0);
					expect(
						profile.startupUiHookQueryCensus.lixrayObserve,
					).toBeGreaterThan(0);
					for (const [name, budget] of Object.entries(
						startupUiHookQueryBudget,
					)) {
						expect(
							profile.startupUiHookQueryCensus[
								name as keyof typeof startupUiHookQueryBudget
							],
							`${name} startup fan-out exceeded its lazy home-view budget`,
						).toBeLessThanOrEqual(budget);
					}
				}
				expect(warmReopenPhases.map((phase) => phase.name)).toEqual(phaseNames);
				for (let index = 1; index < warmReopenPhases.length; index += 1) {
					expect(warmReopenPhases[index]!.startTime).toBeGreaterThanOrEqual(
						warmReopenPhases[index - 1]!.startTime,
					);
				}
			}
			return { ...state, fresh };
		}
		type HistoryState = Awaited<ReturnType<typeof checkpoint>> & {
			concurrentFileIds: string[];
		};
		async function partialCheckpoint(state: HistoryState) {
			const {
				fresh,
				createdFileId,
				concurrentFileIds,
				checkpointCountBeforeFirstClick,
				firstCheckpointCommitId,
			} = state;

			for (const fileId of concurrentFileIds) {
				await expect(await libraryFileEntry(fresh, fileId)).toBeVisible();
			}
			const reopenedHistory = await openHistoryPanel(fresh);
			await waitForHistoryCountsToMatchAuthority(
				[reopenedHistory],
				checkpointCountBeforeFirstClick + 1,
				realtimeTimeout,
			);
			const fileIdsBeforeAfterReopenCreate = await libraryFileIds(fresh);
			await createFileFromLibrary(left, "md");
			const [afterReopenFileId] = await waitForNewLibraryFileIds(
				fresh,
				fileIdsBeforeAfterReopenCreate,
				1,
				realtimeTimeout,
			);
			const afterReopenUrl = left.url();
			const afterReopenEditor = left.locator(
				'.ProseMirror[contenteditable="true"]:visible',
			);
			const afterReopenMarker = `after-reopen-${Date.now()}`;
			await afterReopenEditor.click();
			await left.keyboard.insertText(afterReopenMarker);
			await left.keyboard.press("Tab");
			await expect(
				await libraryFileEntry(fresh, afterReopenFileId!),
			).toBeVisible({
				timeout: realtimeTimeout,
			});
			await fresh.goto(afterReopenUrl);
			await expect(
				fresh.locator('.ProseMirror[contenteditable="true"]:visible'),
			).toContainText(afterReopenMarker, { timeout: realtimeTimeout });

			// Exercise the same warm-replica path for branch checkpoint state. The
			// reopened client must observe an additional checkpoint, not merely keep
			// rendering the checkpoint rows imported during bootstrap.
			await expect(
				left
					.locator('[data-attr="panel-tab-select"]')
					.filter({ hasText: new RegExp(`^${afterReopenMarker}\\.md$`) }),
			).toBeVisible({ timeout: realtimeTimeout });
			const checkpointCountBeforeSecondClick = await authorityCheckpointCount();
			const workingSetFileIds = async (page: Page) =>
				page
					.locator('[data-testid^="diff-scope-file:"]')
					.evaluateAll((rows) =>
						rows
							.map((row) =>
								row
									.getAttribute("data-testid")!
									.slice("diff-scope-file:".length),
							)
							.sort(),
					);
			let filesBeforePartialCheckpoint: string[] = [];
			const secondCheckpointCommitId = await clickCheckpoint(left, async () => {
				await left
					.getByRole("button", { name: /Working set: \d+ of \d+ files/ })
					.click();
				filesBeforePartialCheckpoint = await workingSetFileIds(left);
				for (const id of [
					createdFileId!,
					...concurrentFileIds,
					afterReopenFileId!,
				]) {
					expect(filesBeforePartialCheckpoint).toContain(id);
				}
				// The "All files" master row ticks everything unless everything
				// is ticked, in which case it unticks everything: start from none.
				const allFiles = left.getByRole("checkbox", {
					name: "All files",
					exact: true,
				});
				if ((await allFiles.getAttribute("aria-checked")) !== "true") {
					await allFiles.click();
					await expect(allFiles).toHaveAttribute("aria-checked", "true");
				}
				await allFiles.click();
				await expect(allFiles).toHaveAttribute("aria-checked", "false");
				const selectedFile = left.getByTestId(
					`diff-scope-file:${afterReopenFileId}`,
				);
				await selectedFile.click();
				await expect(selectedFile).toHaveAttribute("aria-checked", "true");
				await expect(
					left.locator('[data-attr="diff-scope-file"][aria-checked="true"]'),
				).toHaveCount(1);
			});
			expect(secondCheckpointCommitId).not.toBe(firstCheckpointCommitId);
			const postReopenHistory = await openHistoryPanel(fresh);
			await waitForHistoryCountsToMatchAuthority(
				[postReopenHistory],
				checkpointCountBeforeSecondClick + 1,
				realtimeTimeout,
			);
			const remainingFileIds = filesBeforePartialCheckpoint.filter(
				(id) => id !== afterReopenFileId,
			);
			// The preview persists across runs, and unseen files stay uncheckpointed.
			// Verify exact identity preservation instead of assuming a clean repository.
			for (const page of [left, fresh]) {
				const count = remainingFileIds.length;
				const status = page.getByRole("button", {
					name: `${count} ${count === 1 ? "file" : "files"} changed since checkpoint. Review working changes`,
					exact: true,
				});
				await expect(status).toBeVisible({ timeout: realtimeTimeout });
				await openRepositoryWorkingChanges(page);
				await page
					.getByRole("button", { name: /Working set: \d+ of \d+ files/ })
					.click();
				await expect
					.poll(() => workingSetFileIds(page), { timeout: realtimeTimeout })
					.toEqual(remainingFileIds);
				await page
					.getByRole("button", { name: /Working set: \d+ of \d+ files/ })
					.click();
				await page.getByRole("button", { name: "Exit", exact: true }).click();
			}
		}
		async function history(state: EditingState) {
			const { fresh } = state;

			const coldReadsBeforeHistory = coldReadCount([left, right]);
			for (const page of [left, right]) {
				const history = await openHistoryPanel(page);
				await waitForHistoryCountsToMatchAuthority(
					[history],
					0,
					repositoryOperationTimeout,
				);
				await expect(history).toContainText("Working changes");
				await expect(history).toContainText("Latest checkpoint");
				await expect(history).toContainText("Initial checkpoint");
			}
			// Bounded, not zero: the relation-scoped working diff reads commit
			// trees (see the fresh-bootstrap budget above).
			if (scenario === "performance") {
				expect(coldReadCount([left, right])).toBeLessThanOrEqual(
					coldReadsBeforeHistory + 4,
				);
			}

			if (scenario === "performance") return;

			// The checkpoint list is hot, but opening a checkpoint intentionally
			// crosses the lazy-history boundary. Exercise that boundary on the fresh
			// replica and report its request count without imposing a zero-read budget.
			const freshReadsBeforeCheckpoint = coldReadCount([fresh]);
			const freshHistory = await openHistoryPanel(fresh);
			await freshHistory
				.getByRole("button", { name: /Latest checkpoint/ })
				.click();
			await expect(fresh.getByRole("button", { name: "Exit" })).toBeVisible({
				timeout: 30_000,
			});
			await expect(
				freshHistory.getByRole("list", { name: "Files at this checkpoint" }),
			).toBeVisible({ timeout: 30_000 });
			await expect(
				fresh.locator("[data-atelier-extension-suspended]"),
			).toHaveCount(0);
			test.info().annotations.push({
				type: "lazy-history-reads",
				description: String(
					coldReadCount([fresh]) - freshReadsBeforeCheckpoint,
				),
			});
		}
		async function close(primaryFailure?: unknown) {
			await Promise.all([...pendingMergeClassifications]);
			await Promise.all([...pendingSyncFailureDetails]);
			if (scenario === "editing" || scenario === "history") {
				const diagnostics = await Promise.allSettled(
					contexts
						.flatMap((context) => context.pages())
						.filter((page) => !page.isClosed())
						.slice(0, 4)
						.map(collectSyncDiagnostics),
				);
				await test.info().attach("replica-editor-diagnostics.json", {
					body: JSON.stringify(diagnostics, null, 2),
					contentType: "application/json",
				});
			}
			const recoveredPushes = transientPushRecovery.recovered();
			const recoveredConsoleCounts = new Map<string, number>();
			for (const push of recoveredPushes) {
				const key = JSON.stringify([push.source, push.url]);
				recoveredConsoleCounts.set(
					key,
					(recoveredConsoleCounts.get(key) ?? 0) + 1,
				);
			}
			const unresolvedConsoleFailures = transientPushConsoleFailures
				.filter((failure) => {
					const key = JSON.stringify([failure.source, failure.url]);
					const recovered = recoveredConsoleCounts.get(key) ?? 0;
					if (recovered === 0) return true;
					recoveredConsoleCounts.set(key, recovered - 1);
					return false;
				})
				.map((failure) => failure.message);
			const unresolvedSyncFailures = [
				...syncFailures,
				...transientPushRecovery.failures(),
				...mergeReplay.failures(),
				...retainedBodyRecovery.failures(),
			];
			const unresolvedRuntimeFailures = [
				...runtimeFailures,
				...unresolvedConsoleFailures,
			];
			await test.info().attach("sync-diagnostics.json", {
				body: JSON.stringify(
					{
						scenario,
						repositoryId,
						syncFailures: unresolvedSyncFailures,
						syncFailureDetails,
						recoveredTransientPushFailures: recoveredPushes.map(
							(push) => `${push.status} ${push.url}`,
						),
						recoveredRetainedBodyResponses: retainedBodyRecovery.recovered(),
						typedMergeConflicts: recoveredMergeConflicts,
						replayedMergeConflicts: mergeReplay.recovered(),
						runtimeFailures: unresolvedRuntimeFailures,
						analyticsStubFailures,
					},
					null,
					2,
				),
				contentType: "application/json",
			});
			try {
				expect(analyticsStubFailures).toEqual([]);
				expect(unresolvedSyncFailures).toEqual([]);
				expect(unresolvedRuntimeFailures).toEqual([]);
			} catch (error) {
				if (primaryFailure === undefined) throw error;
				await test.info().attach("cleanup-failure.txt", {
					body: String(error),
					contentType: "text/plain",
				});
			} finally {
				await Promise.all(contexts.map((context) => context.close()));
			}
		}
		return {
			navigation,
			checkpointConversation,
			editing,
			checkpoint,
			concurrent,
			independentConflicts,
			continuousIndependentEdits,
			staleReopen,
			reopen,
			partialCheckpoint,
			history,
			close,
		};
	} catch (error) {
		// Setup can fail before the caller receives the fixture's close hook.
		await Promise.allSettled(contexts.map((context) => context.close()));
		throw error;
	}
}
