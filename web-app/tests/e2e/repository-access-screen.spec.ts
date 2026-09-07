import { expect, test } from "@playwright/test";

const fileUrl = "/@opral/monorepo/file/company-brain-productization.md";

test("initial HTML includes the access screen and uncollapsed accessible MCP instructions", async ({
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
		await expect(page.locator("details")).not.toHaveAttribute("open");
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

for (const width of [1280, 360]) {
	test(`access resolution preserves the screen without an Atelier flash at ${width}px`, async ({
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
				if (document.querySelector("[data-app-titlebar]")) seen.push("atelier");
			}).observe(document, {
				childList: true,
				subtree: true,
				attributes: true,
			});
		});
		await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
		const heading = page.getByRole("heading", { name: "Opening file..." });
		await expect(heading).toBeVisible();
		const before = await heading.boundingBox();
		release();
		const unavailable = page.getByRole("heading", {
			name: "This file isn't available",
		});
		await expect(unavailable).toBeVisible();
		const after = await unavailable.boundingBox();
		expect(after!.y).toBeCloseTo(before!.y, 0);
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

test("a failed access check offers retry without reporting a 404", async ({
	page,
}) => {
	let attempts = 0;
	await page.route("**/rest/v1/**", async (route) => {
		if (
			route.request().url().includes("resolve_public_lix_by_route") &&
			attempts++ === 0
		) {
			await route.fulfill({
				status: 503,
				json: { message: "Temporarily unavailable" },
			});
		} else {
			await route.fulfill({ json: [] });
		}
	});
	await page.goto(fileUrl);
	await expect(
		page.getByRole("heading", { name: "Unable to check file access" }),
	).toBeVisible();
	await expect(page.getByText("404", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "This file isn't available" }),
	).toBeVisible();
});
