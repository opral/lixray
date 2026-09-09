import {
	expect,
	type Locator,
	type Page,
	type Request,
	test,
} from "@playwright/test";

const DEMO_LIX_ID = "00000000-0000-4000-8000-000000000002";

test("deployed OPFS tabs share one replica and sync files, editors, and hot checkpoint history", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(600_000);
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
		`/lix/v1/${DEMO_LIX_ID}/sync/pull?after=18446744073709551615&limit=512`,
		baseURL,
	).toString();
	await left.goto(new URL("/", baseURL).toString());
	const cacheProbes = await left.evaluate(async (url) => {
		const probe = async () => {
			const response = await fetch(url, {
				headers: {
					Authorization: "Bearer lixray-demo",
					"Lix-Session-Id": "0".repeat(64),
					"Lix-Sync-Protocol-Version": "9",
					"Lix-Server-Protocol-Version": "7",
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
	let intentionallyOffline = false;
	const offlineRequests = new WeakSet<Request>();
	const coldReads = new Map<Page, string[]>();
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
	const authorityCheckpointCount = async (): Promise<number> => {
		const repositoryEndpoint = new URL(
			`/lix/v1/${DEMO_LIX_ID}/`,
			baseURL,
		).toString();
		const authorization = {
			Authorization: "Bearer lixray-demo",
			"Lix-Server-Protocol-Version": "7",
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
						"Idempotency-Key": `lixray-preview-checkpoint-read-${Date.now()}-${authorityReadSequence++}`,
						"Lix-Session-Id": sessionId,
					},
					data: {
						sql: "SELECT count(*) AS checkpoint_count FROM lix_log() WHERE is_checkpoint",
						params: [],
					},
				},
			);
			expect(response.ok()).toBe(true);
			const result = (await response.json()) as {
				rows?: Array<Array<{ kind?: string; value?: unknown }>>;
			};
			const cell = result.rows?.[0]?.[0];
			if (cell?.kind !== "int" || typeof cell.value !== "number") {
				throw new Error("authority returned an invalid checkpoint count");
			}
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
							history
								.getByRole("list", { name: "Checkpoints" })
								.locator(":scope > li")
								.count(),
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
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
			})
			.click();
		const navigator = page.getByRole("complementary", {
			name: "Navigator",
			exact: true,
		});
		await expect(
			navigator.getByRole("region", { name: "Checkpoint history" }),
		).toBeVisible();
		// The active file may already be checkpointed while other files remain dirty.
		const repositoryScope = navigator.getByRole("button", {
			name: "Showing this file. Switch to the repository",
			exact: true,
		});
		if (await repositoryScope.isVisible()) await repositoryScope.click();
		await navigator
			.getByRole("button", { name: "Working changes", exact: true })
			.click();
	};
	const clickCheckpoint = async (
		page: Page,
		selectFiles?: () => Promise<void>,
	): Promise<string> => {
		const before = await authorityCheckpointCount();
		const historyBefore = await openHistoryPanel(right);
		const localCount = await historyBefore
			.getByRole("list", { name: "Checkpoints" })
			.locator(":scope > li")
			.count();
		const localCheckpointIds = new Set<string>();
		const captureCheckpoint = (request: Request) => {
			if (request.method() !== "POST" || !request.url().endsWith("/sync/push"))
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
		await selectFiles?.();
		// Review presentation can load asynchronously. Finish that online setup
		// before measuring the local checkpoint with the network unavailable.
		const checkpointButton = page.getByRole("button", {
			name: "Checkpoint",
			exact: true,
		});
		await expect(checkpointButton).toBeVisible({ timeout: 30_000 });
		await expect(checkpointButton).toBeEnabled({ timeout: 30_000 });
		sharedContext.on("request", captureCheckpoint);
		intentionallyOffline = true;
		await sharedContext.setOffline(true);
		try {
			const checkpointDeadline = Date.now() + 5_000;
			await checkpointButton.click({ timeout: 5_000 });
			const remainingCheckpointTime = checkpointDeadline - Date.now();
			expect(remainingCheckpointTime).toBeGreaterThan(0);
			await expect(
				page.getByRole("button", { name: /^(Checkpoint|Checkpointing…)$/ }),
			).toHaveCount(0, { timeout: remainingCheckpointTime });
			// The second tab observes the same durable OPFS commit while the
			// server is unreachable; no foreground /execute receipt is needed.
			await expect(
				historyBefore
					.getByRole("list", { name: "Checkpoints" })
					.locator(":scope > li"),
			).toHaveCount(localCount + 1, { timeout: 5_000 });
		} finally {
			await sharedContext.setOffline(false);
			intentionallyOffline = false;
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
		const endpoint = new URL(`/lix/v1/${DEMO_LIX_ID}/`, baseURL).toString();
		const authorization = {
			Authorization: "Bearer lixray-demo",
			"Lix-Server-Protocol-Version": "7",
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
									"Idempotency-Key": `local-checkpoint-read-${Date.now()}-${authorityReadSequence++}`,
								},
								data: {
									sql: "SELECT id AS commit_id FROM lix_commit WHERE id = $1 AND is_checkpoint",
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
		const pageColdReads: string[] = [];
		coldReads.set(page, pageColdReads);
		const pageBlobLaneRequests: string[] = [];
		blobLaneRequests.set(page, pageBlobLaneRequests);
		const pageBlobLanePayloadSizes: number[] = [];
		blobLanePayloadSizes.set(page, pageBlobLanePayloadSizes);
		page.on("request", (request) => {
			if (intentionallyOffline) offlineRequests.add(request);
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
			const expectedOfflineNoise =
				intentionallyOffline &&
				/ERR_INTERNET_DISCONNECTED/.test(message.text());
			if (
				message.type() === "error" &&
				!expectedCasNoise &&
				!expectedOfflineNoise
			) {
				runtimeFailures.push(`${label} console: ${message.text()}`);
			}
		});
		page.on("requestfailed", (request) => {
			pendingBlobLaneRequests.delete(request);
			const errorText = request.failure()?.errorText ?? "unknown";
			if (
				(intentionallyOffline || offlineRequests.has(request)) &&
				/ERR_INTERNET_DISCONNECTED/.test(errorText)
			)
				return;
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
				await homeTab.click();
			}
			await newButton.or(gettingStarted).first().waitFor({ timeout: 120_000 });
		};
		const createFileFromHome = async (
			page: Page,
			extension: "md" | "csv" | "excalidraw",
		): Promise<void> => {
			await openHome(page);
			const homeUrl = page.url();
			if (await page.getByTestId("home-getting-started").isVisible()) {
				await page.getByTestId(`home-create-file-${extension}`).click();
			} else {
				await page.getByTestId("home-new-button").click();
				await page.getByTestId(`home-create-file-${extension}`).click();
			}
			await expect(page).not.toHaveURL(homeUrl, {
				timeout: repositoryOperationTimeout,
			});
		};
		const homeFileIds = async (page: Page): Promise<string[]> =>
			page.getByTestId("home-file-entry").evaluateAll((entries) =>
				entries
					.map((entry) => entry.getAttribute("data-file-id"))
					.filter((id): id is string => id !== null)
					.sort(),
			);
		const homeFileEntry = (page: Page, fileId: string) =>
			page
				.getByTestId("home-file-entry")
				.and(page.locator(`[data-file-id="${fileId}"]`));
		const waitForRepositoryHome = async (page: Page) => {
			await page
				.getByTestId("home-new-button")
				.or(page.getByTestId("home-getting-started"))
				.first()
				.waitFor({ timeout: 120_000 });
		};
		const waitForNewHomeFileIds = async (
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
						addedIds = (await homeFileIds(page)).filter(
							(id) => !previous.has(id),
						);
						return addedIds.length;
					},
					{ timeout },
				)
				.toBe(expectedCount);
			return addedIds;
		};

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
			expect(repositoryIds).toContain(DEMO_LIX_ID);

			for (const repository of repositories) {
				await left.goto(new URL("/home", baseURL).toString());
				await expect(left.getByTestId("repository-directory")).toBeVisible();
				await left
					.getByTestId("repository-link")
					.and(left.locator(`[data-repository-id="${repository.id!}"]`))
					.click();
				await waitForRepositoryHome(left);
				await expect(left.getByTestId("repository-picker")).toHaveAttribute(
					"data-repository-id",
					repository.id!,
				);

				// Exercise the shareable direct URL independently from the directory link.
				await left.goto(repository.href);
				await waitForRepositoryHome(left);
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
				await left.goto(new URL(`${repositoryPath}/team`, baseURL).toString());
				await expect(left.getByTestId("repository-people-view")).toBeVisible({
					timeout: repositoryOperationTimeout,
				});
				await left.goto(
					new URL(`${repositoryPath}/settings`, baseURL).toString(),
				);
				await expect(left.getByTestId("repository-settings-view")).toBeVisible({
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
			await waitForRepositoryHome(left);
			for (const repository of [...repositories.slice(1), repositories[0]!]) {
				await left.getByTestId("repository-picker").click();
				await left
					.getByTestId("repository-picker-item")
					.and(left.locator(`[data-repository-id="${repository.id!}"]`))
					.click();
				await waitForRepositoryHome(left);
				await expect(left.getByTestId("repository-picker")).toHaveAttribute(
					"data-repository-id",
					repository.id!,
				);
				await left.goto(new URL("/open", baseURL).toString());
				await waitForRepositoryHome(left);
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
			await createFileFromHome(left, "md");
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
		const initialCheckpointCount = await waitForHistoryCountsToMatchAuthority(
			[initialLeftHistory],
			0,
			repositoryOperationTimeout,
		);
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
			// Closing review restores a prior tab (including SQL from the entry
			// tour). Keep the receiving client's live Home open for discovery.
			await left.getByRole("button", { name: "Home", exact: true }).click();
			await expect(left.getByTestId("home-entry-list")).toBeVisible();
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

		const fileIdsBeforeCreatedFile = await homeFileIds(left);
		await right.getByTestId("home-new-button").click();
		await right.getByTestId("home-create-file-md").click();
		const rightEditor = right.locator(
			'.ProseMirror[contenteditable="true"]:visible',
		);
		await rightEditor.waitFor({ timeout: 30_000 });
		const createdUrl = right.url();
		const [createdFileId] = await waitForNewHomeFileIds(
			left,
			fileIdsBeforeCreatedFile,
			1,
			realtimeTimeout,
		);
		await expect(homeFileEntry(left, createdFileId!)).toBeVisible();
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
				const freshContext = await browser.newContext();
				contexts.push(freshContext);
				const fresh = await freshContext.newPage();
				observePage(fresh, "fresh");
				await fresh.goto(repositoryUrl);
				await expect(homeFileEntry(fresh, createdFileId!)).toBeVisible({
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
				if (initialCheckpointCount > 1) {
					await expect(freshHistory).toContainText("Latest checkpoint");
				}
				if (initialCheckpointCount > 0) {
					await expect(freshHistory).toContainText("Initial checkpoint");
				}
				await expect(
					fresh.locator("[data-atelier-extension-suspended]"),
				).toHaveCount(0);
				// Working changes use the engine's hot authority. Keep a bounded
				// allowance for historical checkpoint metadata on a fresh replica.
				expect(coldReadCount([fresh])).toBeLessThanOrEqual(
					coldReadsBeforeFreshHistory + 2,
				);
				return { freshContext, fresh };
			});
		let { fresh } = freshBootstrap;
		const { freshContext } = freshBootstrap;

		// Keep the originating editor warm for the reverse direction. Reload and
		// OPFS-resume behavior is qualified independently below; coupling it to the
		// realtime budget made this assertion measure startup contention.
		const blobLaneBeforeLeftEdit = blobLaneRequestCount([left, right]);
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
		expect(blobLaneRequestCount([left, right])).toBe(blobLaneBeforeLeftEdit);
		for (const page of [left, right]) {
			await expect(
				page.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
				}),
			).toBeVisible({ timeout: 30_000 });
		}

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
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
			}),
		).toBeVisible({ timeout: realtimeTimeout });

		// Both tabs share one OPFS writer, so concurrent UI actions serialize
		// into one local commit chain and both reach the independent replica.
		const fileIdsBeforeConcurrentCreates = await homeFileIds(fresh);
		await Promise.all([
			createFileFromHome(left, "md"),
			createFileFromHome(right, "csv"),
		]);
		const concurrentFileIds = await waitForNewHomeFileIds(
			fresh,
			fileIdsBeforeConcurrentCreates,
			2,
			30_000,
		);
		// Keep both writers alive until the background upload reaches the
		// independent replica; reopen durability is exercised separately below.
		await Promise.all([left.goto(repositoryUrl), right.goto(repositoryUrl)]);
		for (const page of [left, right]) {
			for (const fileId of concurrentFileIds) {
				await expect(homeFileEntry(page, fileId)).toBeVisible({
					timeout: 30_000,
				});
			}
			await expect(
				page.getByRole("button", {
					name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
				}),
			).toBeVisible({ timeout: 30_000 });
		}

		// The already-qualified incognito client must stay live through a stale
		// push reconciliation; do not hide this behind a second cold bootstrap.
		const mountedConcurrentViewKinds = new Set<string>();
		for (const fileId of concurrentFileIds) {
			await expect(homeFileEntry(fresh, fileId)).toBeVisible({
				timeout: 30_000,
			});
			const homeUrl = fresh.url();
			await homeFileEntry(fresh, fileId).click();
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
			await openHome(fresh);
			await expect(homeFileEntry(fresh, fileId)).toBeVisible({
				timeout: repositoryOperationTimeout,
			});
		}
		expect([...mountedConcurrentViewKinds].sort()).toEqual([
			"atelier_csv",
			"atelier_file",
		]);
		await expect(
			fresh.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
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
			await expect(homeFileEntry(fresh, createdFileId!)).toBeVisible({
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
		for (const fileId of concurrentFileIds) {
			await expect(homeFileEntry(fresh, fileId)).toBeVisible();
		}
		const reopenedHistory = await openHistoryPanel(fresh);
		await waitForHistoryCountsToMatchAuthority(
			[reopenedHistory],
			checkpointCountBeforeFirstClick + 1,
			realtimeTimeout,
		);
		const fileIdsBeforeAfterReopenCreate = await homeFileIds(fresh);
		await createFileFromHome(left, "md");
		const [afterReopenFileId] = await waitForNewHomeFileIds(
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
		await expect(homeFileEntry(fresh, afterReopenFileId!)).toBeVisible({
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
							row.getAttribute("data-testid")!.slice("diff-scope-file:".length),
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
			await left
				.getByRole("checkbox", { name: "Seen files", exact: true })
				.click();
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
				name: `${count} ${count === 1 ? "file" : "files"} changed since checkpoint. Open checkpoint history`,
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
