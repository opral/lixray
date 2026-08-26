import { expect, type Page, type Request, test } from "@playwright/test";

test("deployed OPFS tabs share one replica and sync files, editors, and hot checkpoint history", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(300_000);
	test.skip(
		!process.env.PLAYWRIGHT_SYNC_PREVIEW,
		"requires a deployed preview",
	);
	if (!baseURL) throw new Error("PLAYWRIGHT_BASE_URL is required");
	const expectedDeploymentId = process.env.PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID;
	if (!expectedDeploymentId) {
		throw new Error("PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID is required");
	}

	const repositoryUrl = new URL("/@acme/launch-q3", baseURL).toString();
	const realtimeTimeout = 30_000;
	const repositoryOperationTimeout = 90_000;
	const sharedContext = await browser.newContext();
	const contexts = [sharedContext];
	const [left, right] = await Promise.all([
		sharedContext.newPage(),
		sharedContext.newPage(),
	]);
	const healthResponse = await contexts[0]!.request.get(
		new URL("/healthz", baseURL).toString(),
	);
	expect(healthResponse.status()).toBe(200);
	expect(healthResponse.headers()["x-railway-deployment-id"]).toBe(
		expectedDeploymentId,
	);
	expect(await healthResponse.json()).toMatchObject({
		ok: true,
		service: "lixray",
		deploymentId: expectedDeploymentId,
	});
	const cacheProbeUrl = new URL(
		"/@acme/launch-q3/lix/v1/sync/pull?after=18446744073709551615&limit=512",
		baseURL,
	).toString();
	await left.goto(new URL("/", baseURL).toString());
	const cacheProbes = await left.evaluate(async (url) => {
		const probe = async () => {
			const response = await fetch(url, {
				headers: {
					Authorization: "Bearer lixray-demo",
					"Lix-Session-Id": "0".repeat(64),
				},
			});
			return {
				status: response.status,
				cacheControl: response.headers.get("cache-control"),
				requestId: response.headers.get("x-railway-request-id"),
			};
		};
		return [await probe(), await probe()];
	}, cacheProbeUrl);
	for (const probe of cacheProbes) {
		expect(probe).toMatchObject({ status: 410, cacheControl: "no-store" });
		expect(probe.requestId).toBeTruthy();
	}
	expect(cacheProbes[1]!.requestId).not.toBe(cacheProbes[0]!.requestId);
	const syncFailures: string[] = [];
	const runtimeFailures: string[] = [];
	const coldReads = new Map<Page, string[]>();
	const blobLaneRequests = new Map<Page, string[]>();
	const blobLanePayloadSizes = new Map<Page, number[]>();
	const pendingBlobLaneResponses = new Set<Promise<void>>();
	const pendingBlobLaneRequests = new Set<Request>();
	const unreadableBlobLaneResponses = new Map<Request, string>();
	const blobLaneObservationFailures: string[] = [];
	const openHistoryPanel = async (page: Page) => {
		const history = page.getByRole("region", {
			name: "Checkpoint history",
		});
		if (await history.isVisible()) return history;
		const panelToggle = page.getByRole("button", {
			name: "Toggle right panel",
		});
		if ((await panelToggle.getAttribute("aria-pressed")) === "false") {
			await panelToggle.click();
		}
		const historyTab = page
			.getByRole("button", { name: "History", exact: true })
			.last();
		const selectedHistoryMenu = page.getByRole("button", {
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
		return history;
	};
	const observePage = (page: Page, label: string) => {
		const pageColdReads: string[] = [];
		coldReads.set(page, pageColdReads);
		const pageBlobLaneRequests: string[] = [];
		blobLaneRequests.set(page, pageBlobLaneRequests);
		const pageBlobLanePayloadSizes: number[] = [];
		blobLanePayloadSizes.set(page, pageBlobLanePayloadSizes);
		page.on("request", (request) => {
			if (
				request.method() === "GET" &&
				/\/sync\/(history|blob|chunk)(?:\?|$)/.test(request.url())
			) {
				pageColdReads.push(request.url());
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
		});
		page.on("pageerror", (error) => {
			runtimeFailures.push(`${label} pageerror: ${error.message}`);
		});
		page.on("console", (message) => {
			// Chromium mirrors an expected HTTP 409 response to the console without
			// exposing its URL. The response listener below classifies the push CAS
			// conflict precisely and still rejects every other sync failure.
			const expectedCasNoise =
				message.type() === "error" &&
				/Failed to load resource:.*status of 409/i.test(message.text());
			if (message.type() === "error" && !expectedCasNoise) {
				runtimeFailures.push(`${label} console: ${message.text()}`);
			}
		});
		page.on("requestfailed", (request) => {
			pendingBlobLaneRequests.delete(request);
			const errorText = request.failure()?.errorText ?? "unknown";
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
			if (!url.includes("/lix/v1/sync/")) return;
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
			// Push has no idempotency key, so its only 409 mapping is the expected
			// ref-CAS race. Convergence below proves that reconciliation completed.
			if (
				response.status() >= 400 &&
				!(response.status() === 409 && url.endsWith("/sync/push"))
			) {
				syncFailures.push(`${response.status()} ${url}`);
			}
		});
	};
	const coldReadCount = (pages: Page[]) =>
		pages.reduce(
			(count, page) => count + (coldReads.get(page)?.length ?? 0),
			0,
		);
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

	try {
		const openHome = async (page: Page) => {
			await page.goto(repositoryUrl);
			const newButton = page.getByTestId("home-new-button");
			const gettingStarted = page.getByTestId("home-getting-started");
			if (!(await newButton.or(gettingStarted).first().isVisible())) {
				const homeTab = page.getByRole("button", {
					name: "Home",
					exact: true,
				});
				await homeTab.waitFor({ timeout: 120_000 });
				// Pinned Atelier tabs are sortable and expose aria-disabled while
				// remaining selectable. Bypass Playwright's disabled actionability
				// check so the test follows the same pointer activation path.
				await homeTab.click({ force: true });
			}
			await newButton.or(gettingStarted).first().waitFor({ timeout: 120_000 });
		};
		const createFileFromHome = async (
			page: Page,
			buttonName: string,
		): Promise<string> => {
			await openHome(page);
			const homeUrl = page.url();
			if (await page.getByTestId("home-getting-started").isVisible()) {
				const onboardingButtonName = buttonName
					.replace(/^New /, "")
					.replace(/ \(\.[^)]+\)$/, "");
				await page
					.getByRole("button", { name: onboardingButtonName, exact: true })
					.click();
			} else {
				await page.getByTestId("home-new-button").click();
				await page
					.getByRole("button", { name: buttonName, exact: true })
					.click();
			}
			await expect(page).not.toHaveURL(homeUrl, {
				timeout: repositoryOperationTimeout,
			});
			return decodeURIComponent(
				new URL(page.url()).pathname.split("/").at(-1) ?? "",
			);
		};

		await Promise.all([openHome(left), openHome(right)]);
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

		if (!(await left.getByTestId("home-entry-list").isVisible())) {
			await createFileFromHome(left, "New Markdown (.md)");
			await right
				.getByTestId("home-getting-started")
				.waitFor({ state: "hidden", timeout: repositoryOperationTimeout });
			await Promise.all([openHome(left), openHome(right)]);
		}
		await Promise.all([
			left.getByTestId("home-entry-list").waitFor({ timeout: 120_000 }),
			right.getByTestId("home-entry-list").waitFor({ timeout: 120_000 }),
		]);
		const initialLeftHistory = await openHistoryPanel(left);
		const initialCheckpointCount = await initialLeftHistory
			.getByRole("list", { name: "Checkpoints" })
			.locator(":scope > li")
			.count();
		expect(initialCheckpointCount).toBeGreaterThan(0);
		if (initialCheckpointCount > 1) {
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
				.getByRole("button")
				.click();
			const exitHistory = left.getByRole("button", { name: "Exit" });
			await expect(exitHistory).toBeVisible({
				timeout: repositoryOperationTimeout,
			});
			await exitHistory.click();
			await expect(exitHistory).not.toBeVisible();
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

		await right.getByTestId("home-new-button").click();
		await right
			.getByRole("button", { name: "New Markdown (.md)", exact: true })
			.click();
		const rightEditor = right.locator(
			'.ProseMirror[contenteditable="true"]:visible',
		);
		await rightEditor.waitFor({ timeout: 30_000 });
		const createdUrl = right.url();
		const createdName = decodeURIComponent(
			new URL(createdUrl).pathname.split("/").at(-1) ?? "",
		);
		await expect(left.getByTestId("home-entry-list")).toContainText(
			createdName,
			{ timeout: realtimeTimeout },
		);
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

		const blobLaneBeforeRightEdit = blobLaneRequestCount([left, right]);
		const rightMarker = `right-${Date.now()}`;
		await rightEditor.click();
		await right.keyboard.insertText(rightMarker);
		// Keep ordinary typing focused. This qualifies the editor's debounce and
		// outbox path without relying on a blur/focus transition to publish it.
		await expect(rightEditor).toBeFocused();
		await expect(leftEditor).toContainText(rightMarker, {
			timeout: realtimeTimeout,
		});
		expect(blobLaneRequestCount([left, right])).toBe(blobLaneBeforeRightEdit);

		const freshBootstrap =
			await test.step("fresh/incognito bootstrap renders hot History", async () => {
				// A context created only after the write exercises snapshot bootstrap,
				// as an incognito window does. Qualify History before later realtime
				// assertions so a collaboration failure cannot mask this result.
				const freshContext = await browser.newContext();
				contexts.push(freshContext);
				const fresh = await freshContext.newPage();
				observePage(fresh, "fresh");
				await fresh.goto(repositoryUrl);
				const freshEntries = fresh.getByTestId("home-entry-list");
				await expect(freshEntries).toContainText(createdName, {
					timeout: 120_000,
				});
				const coldReadsBeforeFreshHistory = coldReadCount([fresh]);
				const freshHistory = await openHistoryPanel(fresh);
				await expect(
					freshHistory.getByRole("button", { name: "Working changes" }),
				).toBeVisible();
				await expect(
					freshHistory
						.getByRole("list", { name: "Checkpoints" })
						.locator(":scope > li"),
				).toHaveCount(initialCheckpointCount);
				if (initialCheckpointCount > 1) {
					await expect(freshHistory).toContainText("Latest checkpoint");
				}
				await expect(freshHistory).toContainText("Initial checkpoint");
				await expect(
					fresh.locator("[data-atelier-extension-suspended]"),
				).toHaveCount(0);
				// The relation-scoped working diff (lix_diff over the
				// checkpoint-to-head span) evaluates from commit trees, unlike the
				// retired lix_working_diff() hot authority — opening History may
				// cost a bounded number of cold reads until the engine grows a hot
				// path for the working span.
				expect(coldReadCount([fresh])).toBeLessThanOrEqual(
					coldReadsBeforeFreshHistory + 2,
				);
				return { freshContext, fresh, freshEntries };
			});
		let { fresh, freshEntries } = freshBootstrap;
		const { freshContext } = freshBootstrap;

		// Keep the originating editor warm for the reverse direction. Reload and
		// OPFS-resume behavior is qualified independently below; coupling it to the
		// realtime budget made this assertion measure startup contention.
		const blobLaneBeforeLeftEdit = blobLaneRequestCount([left, right]);
		const leftMarker = `left-${Date.now()}`;
		await leftEditor.click();
		await left.keyboard.press("End");
		await left.keyboard.insertText(leftMarker);
		await left.keyboard.press("Tab");
		await expect(rightEditor).toContainText(leftMarker, {
			timeout: realtimeTimeout,
		});
		expect(blobLaneRequestCount([left, right])).toBe(blobLaneBeforeLeftEdit);
		for (const page of [left, right]) {
			await expect(
				page.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
				}),
			).toBeVisible({ timeout: 30_000 });
		}

		await left
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			})
			.click();
		await left.getByRole("button", { name: "Checkpoint", exact: true }).click();
		const leftHistoryAfterCheckpoint = await openHistoryPanel(left);
		// A Playwright click resolves after dispatch, while the async checkpoint
		// transaction can still be committing locally. Observe the durable row
		// directly; the header shortcut is intentionally hidden while History is open.
		await expect(
			leftHistoryAfterCheckpoint
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 1, {
			timeout: repositoryOperationTimeout,
		});
		const rightHistoryAfterCheckpoint = await openHistoryPanel(right);
		await expect(
			rightHistoryAfterCheckpoint
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 1, { timeout: realtimeTimeout });
		const freshHistoryAfterCheckpoint = await openHistoryPanel(fresh);
		await expect(
			freshHistoryAfterCheckpoint
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 1, { timeout: realtimeTimeout });

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
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			}),
		).toBeVisible({ timeout: realtimeTimeout });

		// Deliberately race two distinct local commits. One push should lose the
		// authority ref-CAS and then reconcile; both replicas must retain both rows.
		const [leftConcurrentName, rightConcurrentName] = await Promise.all([
			createFileFromHome(left, "New Markdown (.md)"),
			createFileFromHome(right, "New CSV (.csv)"),
		]);
		await Promise.all([left.goto(repositoryUrl), right.goto(repositoryUrl)]);
		for (const page of [left, right]) {
			const entries = page.getByTestId("home-entry-list");
			await expect(entries).toContainText(leftConcurrentName, {
				timeout: 30_000,
			});
			await expect(entries).toContainText(rightConcurrentName, {
				timeout: 30_000,
			});
			await expect(
				page.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
				}),
			).toBeVisible({ timeout: 30_000 });
		}

		// The already-qualified incognito client must stay live through a stale
		// push reconciliation; do not hide this behind a second cold bootstrap.
		await expect(freshEntries).toContainText(leftConcurrentName, {
			timeout: 30_000,
		});
		await expect(freshEntries).toContainText(rightConcurrentName, {
			timeout: 30_000,
		});
		await expect(
			fresh.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			}),
		).toBeVisible({ timeout: 30_000 });

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
		for (let sample = 0; sample < 5; sample += 1) {
			await fresh.close();
			fresh = await freshContext.newPage();
			observePage(fresh, `fresh-reopen-${sample + 1}`);
			const reopenStartedAt = Date.now();
			await fresh.goto(repositoryUrl, { waitUntil: "domcontentloaded" });
			freshEntries = fresh.getByTestId("home-entry-list");
			await expect(freshEntries).toContainText(createdName, {
				timeout: 30_000,
			});
			const sampleColdReads = [...(coldReads.get(fresh) ?? [])];
			warmReopenColdReads.push(sampleColdReads);
			warmReopenUsableSamplesMs.push(Date.now() - reopenStartedAt);
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
						.filter((entry) => entry.name.startsWith("lixray:repository-open:"))
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
		const reopenedEntries = freshEntries;
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
		await test.info().attach("warm-reopen-profile.json", {
			body: JSON.stringify(
				{
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
			expect(profile.startupUiHookQueryCensus.atelierObserve).toBeGreaterThan(
				0,
			);
			expect(profile.startupUiHookQueryCensus.lixrayObserve).toBeGreaterThan(0);
			for (const [name, budget] of Object.entries(startupUiHookQueryBudget)) {
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
		await expect(reopenedEntries).toContainText(leftConcurrentName);
		await expect(reopenedEntries).toContainText(rightConcurrentName);
		const reopenedHistory = await openHistoryPanel(fresh);
		await expect(
			reopenedHistory
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 1);
		const afterReopenName = await createFileFromHome(
			left,
			"New Markdown (.md)",
		);
		const afterReopenUrl = left.url();
		const afterReopenEditor = left.locator(
			'.ProseMirror[contenteditable="true"]:visible',
		);
		const afterReopenMarker = `after-reopen-${Date.now()}`;
		await afterReopenEditor.click();
		await left.keyboard.insertText(afterReopenMarker);
		await left.keyboard.press("Tab");
		await expect(reopenedEntries).toContainText(afterReopenName, {
			timeout: realtimeTimeout,
		});
		await fresh.goto(afterReopenUrl);
		await expect(
			fresh.locator('.ProseMirror[contenteditable="true"]:visible'),
		).toContainText(afterReopenMarker, { timeout: realtimeTimeout });

		// Exercise the same warm-replica path for branch checkpoint state. The
		// reopened client must observe an additional checkpoint, not merely keep
		// rendering the checkpoint rows imported during bootstrap.
		await left
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			})
			.click();
		await left
			.getByRole("button", { name: /Working set: \d+ of \d+ files/ })
			.click();
		await left
			.getByRole("checkbox", { name: afterReopenName, exact: true })
			.click();
		await left.getByRole("button", { name: "Checkpoint", exact: true }).click();
		const postReopenHistory = await openHistoryPanel(fresh);
		await expect(
			postReopenHistory
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 2, { timeout: realtimeTimeout });
		for (const page of [left, fresh]) {
			await expect(
				page.getByRole("button", {
					name: "1 file changed since checkpoint. Open changes review",
				}),
			).toBeVisible({ timeout: realtimeTimeout });
		}

		const coldReadsBeforeHistory = coldReadCount([left, right]);
		for (const page of [left, right]) {
			const history = await openHistoryPanel(page);
			await expect(history).toContainText("Working changes");
			await expect(history).toContainText("Latest checkpoint");
			await expect(history).toContainText("Initial checkpoint");
		}
		// Bounded, not zero: the relation-scoped working diff reads commit
		// trees (see the fresh-bootstrap budget above).
		expect(coldReadCount([left, right])).toBeLessThanOrEqual(
			coldReadsBeforeHistory + 4,
		);

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
			description: String(coldReadCount([fresh]) - freshReadsBeforeCheckpoint),
		});
		expect(syncFailures).toEqual([]);
		expect(runtimeFailures).toEqual([]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
