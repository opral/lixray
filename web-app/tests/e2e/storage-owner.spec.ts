import { expect, test, type Page } from "@playwright/test";

type HeldOwner = {
	acquired: boolean;
	release?: () => void;
	error?: string;
};

async function waitForRepository(page: Page) {
	await expect(
		page
			.getByTestId("home-new-button")
			.or(page.getByTestId("home-getting-started")),
	).toBeVisible({ timeout: 60_000 });
}

async function fileIds(page: Page) {
	return page.getByTestId("home-file-entry").evaluateAll((entries) =>
		entries
			.map((entry) => entry.getAttribute("data-file-id"))
			.filter((id): id is string => id !== null)
			.sort(),
	);
}

for (const releaseDuringRetry of [false, true]) {
	test(`storage ownership ${releaseDuringRetry ? "opens after temporary ownership contention" : "replaces an inaccessible replica without releasing the old lock"}`, async ({
		page,
		baseURL,
	}) => {
		test.skip(
			!process.env.PLAYWRIGHT_SYNC_PREVIEW,
			"requires an explicitly selected disposable demo preview",
		);
		if (!baseURL) throw new Error("Playwright baseURL is required");
		const deployment = process.env.PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID;
		if (!deployment)
			throw new Error("PLAYWRIGHT_EXPECTED_DEPLOYMENT_ID is required");
		const health = await page.request.get(
			new URL("/healthz", baseURL).toString(),
		);
		expect(health.ok()).toBe(true);
		expect(health.headers()["x-railway-deployment-id"]).toBe(deployment);
		expect(await health.json()).toMatchObject({
			ok: true,
			service: "lixray",
			deploymentId: deployment,
		});

		// Read the existing disposable demo; never create or edit repository data.
		const repositoryUrl = new URL("/@acme/launch-q3", baseURL).toString();
		await page.goto(repositoryUrl);
		await waitForRepository(page);
		await expect(page.getByTestId("home-file-entry").first()).toBeVisible();
		const before = await fileIds(page);
		const owners = await page.evaluate(
			async () =>
				(await navigator.locks.query()).held
					?.filter((lock) => lock.name?.startsWith("lix:partial-engine:"))
					.map((lock) => lock.name) ?? [],
		);
		expect(owners).toHaveLength(1);
		const ownerName = owners[0]!;
		const context = page.context();
		const holder = await context.newPage();
		await holder.goto(new URL("/healthz", baseURL).toString());
		await holder.evaluate((name) => {
			const control: HeldOwner = { acquired: false };
			(window as unknown as { heldOwner: HeldOwner }).heldOwner = control;
			// Queue behind the real owner. Closing its last tab releases this
			// exact lock naturally; never steal it or alter OPFS storage.
			void navigator.locks
				.request(name, async () => {
					control.acquired = true;
					await new Promise<void>((resolve) => {
						control.release = resolve;
					});
				})
				.catch((error: unknown) => {
					control.error = String(error);
				});
		}, ownerName);
		await page.close();
		await expect
			.poll(
				() =>
					holder.evaluate(
						() =>
							(window as unknown as { heldOwner: HeldOwner }).heldOwner
								.acquired,
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		const contender = await context.newPage();
		try {
			await contender.goto(repositoryUrl);
			if (releaseDuringRetry) {
				// Keep the real owner unavailable while the page starts opening,
				// then release within the existing bounded retry budget.
				await holder.evaluate(() => {
					setTimeout(
						() =>
							(
								window as unknown as { heldOwner: HeldOwner }
							).heldOwner.release?.(),
						1_000,
					);
				});
			} else {
				await waitForRepository(contender);
				await expect(
					contender
						.getByRole("status")
						.filter({ hasText: "Previous device data is preserved" }),
				).toContainText("Previous device data is preserved");
				const retained = await contender.evaluate(() =>
					Object.keys(localStorage)
						.filter((key) => key.startsWith("lixray:replica-replacement:v1:"))
						.map(
							(key) =>
								JSON.parse(localStorage.getItem(key)!) as {
									activeName: string;
									retainedSources: string[];
								},
						),
				);
				expect(retained).toHaveLength(1);
				expect(retained[0].retainedSources).toHaveLength(1);
				expect(retained[0].activeName).not.toBe(retained[0].retainedSources[0]);
				expect(
					await holder.evaluate(
						async (name) =>
							(await navigator.locks.query()).held?.some(
								(lock) => lock.name === name,
							),
						ownerName,
					),
				).toBe(true);
			}
			await waitForRepository(contender);
			await expect(contender.getByRole("alert")).toHaveCount(0);
			await expect.poll(() => fileIds(contender)).toEqual(before);
		} finally {
			await holder.close();
			await contender.close();
		}
	});
}
