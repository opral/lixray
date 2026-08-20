import { expect, type Page, test } from "@playwright/test";

test("deployed OPFS clients sync files, editors, and hot checkpoint history", async ({
	browser,
	baseURL,
}) => {
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
	const realtimeTimeout = 5_000;
	const contexts = await Promise.all([
		browser.newContext(),
		browser.newContext(),
	]);
	const [left, right] = await Promise.all(
		contexts.map((context) => context.newPage()),
	);
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
	const syncFailures: string[] = [];
	const runtimeFailures: string[] = [];
	const coldReads = new Map<Page, string[]>();
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
		await page
			.getByRole("button", { name: "History", exact: true })
			.last()
			.click();
		await expect(history).toBeVisible({ timeout: 30_000 });
		return history;
	};
	const observePage = (page: Page, label: string) => {
		const pageColdReads: string[] = [];
		coldReads.set(page, pageColdReads);
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
			if (request.url().includes("/lix/v1/")) {
				const errorText = request.failure()?.errorText ?? "unknown";
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
			// Push has no idempotency key, so its only 409 mapping is the expected
			// ref-CAS race. Convergence below proves that reconciliation completed.
			if (
				response.status() >= 400 &&
				!(response.status() === 409 && url.endsWith("/sync/push"))
			) {
				syncFailures.push(`${response.status()} ${url}`);
			}
			if (
				response.request().method() === "GET" &&
				/\/sync\/(history|blob|chunk)(?:\?|$)/.test(url)
			) {
				pageColdReads.push(url);
			}
		});
	};
	const coldReadCount = (pages: Page[]) =>
		pages.reduce(
			(count, page) => count + (coldReads.get(page)?.length ?? 0),
			0,
		);
	observePage(left, "left");
	observePage(right, "right");

	try {
		const createFileFromHome = async (
			page: Page,
			buttonName: string,
		): Promise<string> => {
			await page.goto(repositoryUrl);
			await page.getByTestId("home-entry-list").waitFor({ timeout: 30_000 });
			await page.getByTestId("home-new-button").click();
			await page.getByRole("button", { name: buttonName, exact: true }).click();
			await page.waitForURL((url) => url.toString() !== repositoryUrl, {
				timeout: 30_000,
			});
			return decodeURIComponent(
				new URL(page.url()).pathname.split("/").at(-1) ?? "",
			);
		};

		await Promise.all([left.goto(repositoryUrl), right.goto(repositoryUrl)]);
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

		await right.getByTestId("home-new-button").click();
		await right
			.getByRole("button", { name: "New Markdown (.md)", exact: true })
			.click();
		const rightEditor = right.locator('.ProseMirror[contenteditable="true"]');
		await rightEditor.waitFor({ timeout: 30_000 });
		const createdUrl = right.url();
		const createdName = decodeURIComponent(
			new URL(createdUrl).pathname.split("/").at(-1) ?? "",
		);
		const rightMarker = `right-${Date.now()}`;
		await rightEditor.click();
		await right.keyboard.insertText(rightMarker);
		// Keep ordinary typing focused. This qualifies the editor's debounce and
		// outbox path without relying on a blur/focus transition to publish it.
		await expect(rightEditor).toBeFocused();

		await expect(left.getByTestId("home-entry-list")).toContainText(
			createdName,
			{ timeout: realtimeTimeout },
		);
		await left.goto(createdUrl);
		const leftEditor = left.locator('.ProseMirror[contenteditable="true"]');
		await expect(leftEditor).toContainText(rightMarker, {
			timeout: realtimeTimeout,
		});

		const { fresh, freshEntries } =
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
				await expect(freshHistory).toContainText("Latest checkpoint");
				await expect(freshHistory).toContainText("Initial checkpoint");
				await expect(
					fresh.locator("[data-atelier-extension-suspended]"),
				).toHaveCount(0);
				await fresh.waitForTimeout(500);
				expect(coldReadCount([fresh])).toBe(coldReadsBeforeFreshHistory);
				return { fresh, freshEntries };
			});

		// Keep the originating editor warm for the reverse direction. Reload and
		// OPFS-resume behavior is qualified independently below; coupling it to the
		// realtime budget made this assertion measure startup contention.
		const leftMarker = `left-${Date.now()}`;
		await leftEditor.click();
		await left.keyboard.press("End");
		await left.keyboard.insertText(leftMarker);
		await left.keyboard.press("Tab");
		await expect(rightEditor).toContainText(leftMarker, {
			timeout: realtimeTimeout,
		});
		for (const page of [left, right]) {
			await expect(
				page.getByRole("button", {
					name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
				}),
			).toBeVisible({ timeout: 30_000 });
		}

		await left
			.getByRole("button", {
				name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
			})
			.click();
		await left.getByRole("button", { name: "Checkpoint", exact: true }).click();
		// A Playwright click resolves after dispatch, while the async checkpoint
		// transaction can still be committing locally. Start the realtime budget
		// only after the originating replica exposes the durable checkpoint.
		await expect(
			left.getByRole("button", {
				name: "Latest checkpoint. Open checkpoint history",
			}),
		).toBeVisible({ timeout: 30_000 });
		const leftHistoryAfterCheckpoint = await openHistoryPanel(left);
		await expect(
			leftHistoryAfterCheckpoint
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 1, { timeout: 30_000 });
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
				name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
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
					name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
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
				name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
			}),
		).toBeVisible({ timeout: 30_000 });

		// Reuse the same tab identity and OPFS database. Fresh contexts only cover
		// bootstrap; a reload proves that the persisted cursor/read model can resume
		// and still render the latest files and checkpoint rows.
		const freshReplicaTabId = await fresh.evaluate(() =>
			sessionStorage.getItem("lixray:browser-replica-tab:v1"),
		);
		expect(freshReplicaTabId).toBeTruthy();
		await fresh.reload({ waitUntil: "domcontentloaded" });
		expect(
			await fresh.evaluate(() =>
				sessionStorage.getItem("lixray:browser-replica-tab:v1"),
			),
		).toBe(freshReplicaTabId);
		const reopenedEntries = fresh.getByTestId("home-entry-list");
		await expect(reopenedEntries).toContainText(createdName, {
			timeout: 30_000,
		});
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
				name: /[1-9]\d* changes? since checkpoint\. Open changes review/,
			})
			.click();
		await left.getByRole("button", { name: "Checkpoint", exact: true }).click();
		await expect(
			left.getByRole("button", {
				name: "Latest checkpoint. Open checkpoint history",
			}),
		).toBeVisible({ timeout: 30_000 });
		const postReopenHistory = await openHistoryPanel(fresh);
		await expect(
			postReopenHistory
				.getByRole("list", { name: "Checkpoints" })
				.locator(":scope > li"),
		).toHaveCount(initialCheckpointCount + 2, { timeout: realtimeTimeout });

		const coldReadsBeforeHistory = coldReadCount([left, right]);
		for (const page of [left, right]) {
			const history = await openHistoryPanel(page);
			await expect(history).toContainText("Working changes");
			await expect(history).toContainText("Latest checkpoint");
			await expect(history).toContainText("Initial checkpoint");
		}
		await left.waitForTimeout(500);
		expect(coldReadCount([left, right])).toBe(coldReadsBeforeHistory);

		// The checkpoint list is hot, but opening a checkpoint intentionally
		// crosses the lazy-history boundary. Exercise that boundary on the fresh
		// replica and report its request count without imposing a zero-read budget.
		const freshReadsBeforeCheckpoint = coldReadCount([fresh]);
		const freshHistory = await openHistoryPanel(fresh);
		await freshHistory
			.getByRole("button", { name: /Latest checkpoint/ })
			.click();
		await expect(
			fresh.getByRole("button", { name: "Back to now" }),
		).toBeVisible({ timeout: 30_000 });
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
