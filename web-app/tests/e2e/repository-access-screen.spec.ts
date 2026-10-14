import { expect, test } from "@playwright/test";

const fileUrl =
	"/@opral/monorepo/file/AAAAAAAAQACAAAAAAAAAAQ/company-brain-productization.md";

test("initial HTML includes the opening skeleton and accessible MCP instructions", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	});
	try {
		const page = await context.newPage();
		const response = await page.goto(fileUrl);
		const html = await response!.text();
		expect(html).toContain('data-repository-access="pending"');
		await expect(
			page.getByRole("heading", { name: "Opening file..." }),
		).toBeVisible();
		// The workspace's frame: the island and its header, before any access.
		await expect(
			page.locator('[data-repository-access="pending"] main'),
		).toBeVisible();
		await expect(
			page.locator("[data-repository-access-skeleton]"),
		).toHaveAttribute("aria-hidden", "true");
		await expect(page.getByRole("button")).toHaveCount(0);
		await expect(page.locator("details")).toHaveCount(0);
		const instructions = page.locator(
			'body > section[aria-label="Access through LixRay MCP"]',
		);
		expect(await instructions.ariaSnapshot()).toContain("open_lix");
		expect(await instructions.ariaSnapshot()).toContain("structuredContent");
		await expect(instructions).toHaveClass(/sr-only/);
	} finally {
		await context.close();
	}
});

// Both access stages belong to this UI fixture. Leaving the worker lookup live
// makes an unavailable-item assertion depend on the server's database settings.
test.beforeEach(async ({ page }) => {
	await page.route("**/api/published/entity?*", (route) =>
		route.fulfill({ status: 404, json: { error: "Entity not found" } }),
	);
});

for (const width of [1280, 360]) {
	test(`access resolution replaces the opening skeleton without an Atelier flash at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		let release!: () => void;
		const resolution = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/rest/v1/**", async (route) => {
			if (route.request().url().includes("resolve_public_lix_by_route"))
				await resolution;
			await route.fulfill({ json: [] });
		});
		await page.addInitScript(() => {
			const seen: string[] = [];
			Object.assign(window, { accessScreenStates: seen });
			new MutationObserver(() => {
				const screen = document.querySelector("[data-repository-access]");
				const state = screen?.getAttribute("data-repository-access");
				if (state && seen.at(-1) !== state) seen.push(state);
				if (document.querySelector('[data-atelier-part="top-bar"]'))
					seen.push("atelier");
			}).observe(document, {
				childList: true,
				subtree: true,
				attributes: true,
			});
		});
		// The server screen is visible before a cold Vite client has hydrated.
		const accessRequest = page.waitForRequest(
			(request) =>
				request.url().includes("/rest/v1/rpc/resolve_public_lix_by_route"),
			{ timeout: 60_000 },
		);
		await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
		const heading = page.getByRole("heading", { name: "Opening file..." });
		await expect(heading).toBeVisible();
		await expect(
			page.locator("[data-repository-access-skeleton]"),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Sign in|Retry|Switch account/ }),
		).toHaveCount(0);
		await expect(page.locator("details")).toHaveCount(0);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await accessRequest;
		release();
		const unavailable = page.getByRole("heading", {
			name: "This file isn't available",
		});
		await expect(unavailable).toBeVisible();
		await expect(page.locator("[data-repository-access-skeleton]")).toHaveCount(
			0,
		);
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { accessScreenStates: string[] })
						.accessScreenStates,
			),
		).toEqual(["pending", "unavailable"]);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
		await expect(page.locator("details")).not.toHaveAttribute("open");
		expect(
			await page
				.locator('body > section[aria-label="Access through LixRay MCP"]')
				.ariaSnapshot(),
		).toContain("open_lix");
		await page.locator("summary").click();
		await expect(page.locator("details")).toHaveAttribute("open");
		await expect(
			page.locator("details").getByText("open_lix", { exact: true }),
		).toBeVisible();
	});
}

for (const failure of ["repository", "published item"] as const) {
	test(`a failed ${failure} access check offers retry without reporting a 404`, async ({
		page,
	}) => {
		let repositoryAttempts = 0;
		let entityAttempts = 0;
		await page.route("**/rest/v1/**", async (route) => {
			const repositoryLookup = route
				.request()
				.url()
				.includes("resolve_public_lix_by_route");
			if (repositoryLookup) repositoryAttempts++;
			if (
				repositoryLookup &&
				failure === "repository" &&
				repositoryAttempts === 1
			) {
				await route.fulfill({
					status: 503,
					json: { message: "Temporarily unavailable" },
				});
			} else {
				await route.fulfill({ json: [] });
			}
		});
		await page.route("**/api/published/entity?*", async (route) => {
			entityAttempts++;
			if (failure === "published item" && entityAttempts === 1) {
				await route.fulfill({
					status: 503,
					json: { error: "Entity resolution unavailable" },
				});
			} else {
				await route.fulfill({
					status: 404,
					json: { error: "Entity not found" },
				});
			}
		});
		// Measure the error transition after the client actually starts access
		// resolution. A cold Vite graph can leave the SSR skeleton visible while
		// modules load; that is not a completed (or failed) access check.
		const accessRequest = page.waitForRequest(
			(request) =>
				request.url().includes("/rest/v1/rpc/resolve_public_lix_by_route"),
			{ timeout: 60_000 },
		);
		await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
		await accessRequest;
		await expect(
			page.getByRole("heading", { name: "Unable to check file access" }),
		).toBeVisible();
		await expect(page.getByText("404", { exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "This file isn't available" }),
		).toBeVisible();
		expect(repositoryAttempts).toBe(2);
		expect(entityAttempts).toBe(failure === "published item" ? 2 : 1);
	});
}
