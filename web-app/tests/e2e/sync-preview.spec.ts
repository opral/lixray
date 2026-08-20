import { expect, test } from "@playwright/test";

test("deployed OPFS clients sync files, editors, and hot checkpoint history", async ({
	browser,
	baseURL,
}) => {
	test.skip(
		!process.env.PLAYWRIGHT_SYNC_PREVIEW,
		"requires a deployed preview",
	);
	if (!baseURL) throw new Error("PLAYWRIGHT_BASE_URL is required");

	const repositoryUrl = new URL("/@acme/launch-q3", baseURL).toString();
	const contexts = await Promise.all([
		browser.newContext(),
		browser.newContext(),
	]);
	const [left, right] = await Promise.all(
		contexts.map((context) => context.newPage()),
	);
	const syncFailures: string[] = [];
	const coldReads: string[] = [];
	for (const page of [left, right]) {
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
			if (/\/sync\/(history|chunk)(?:\?|$)/.test(url)) {
				coldReads.push(url);
			}
		});
	}

	try {
		await Promise.all([left.goto(repositoryUrl), right.goto(repositoryUrl)]);
		await Promise.all([
			left.getByTestId("home-entry-list").waitFor({ timeout: 120_000 }),
			right.getByTestId("home-entry-list").waitFor({ timeout: 120_000 }),
		]);

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
		await right.keyboard.press("Tab");

		await expect(left.getByTestId("home-entry-list")).toContainText(
			createdName,
			{ timeout: 30_000 },
		);
		await left.goto(createdUrl);
		const leftEditor = left.locator('.ProseMirror[contenteditable="true"]');
		await expect(leftEditor).toContainText(rightMarker, { timeout: 30_000 });

		await right.goto(createdUrl);
		await rightEditor.waitFor({ timeout: 30_000 });
		const leftMarker = `left-${Date.now()}`;
		await leftEditor.click();
		await left.keyboard.press("End");
		await left.keyboard.insertText(leftMarker);
		await left.keyboard.press("Tab");
		await expect(rightEditor).toContainText(leftMarker, { timeout: 30_000 });

		const coldReadsBeforeHistory = coldReads.length;
		for (const page of [left, right]) {
			await page.getByRole("button", { name: "Toggle right panel" }).click();
			await page
				.getByRole("button", { name: "History", exact: true })
				.last()
				.click();
			const history = page.getByRole("region", {
				name: "Checkpoint history",
			});
			await expect(history).toContainText("Working changes");
			await expect(history).toContainText("Initial checkpoint");
		}
		await left.waitForTimeout(500);
		expect(coldReads).toHaveLength(coldReadsBeforeHistory);
		expect(syncFailures).toEqual([]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
