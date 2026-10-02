import { expect, test } from "@playwright/test";

for (const width of [1440, 390, 320]) {
	test(
		"landing hero, preview, and sources fit at " + width + "px",
		async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/");

			await expect(
				page.getByRole("heading", {
					level: 1,
					name: /Shared repository for you and your AI\sagents/,
				}),
			).toBeVisible();
			await expect(page.getByRole("banner")).toBeVisible();
			await expect(
				page.getByRole("navigation", { name: "Primary navigation" }),
			).toBeVisible();
			await expect(page.getByRole("contentinfo")).toBeVisible();
			await expect(
				page.getByRole("navigation", { name: "Footer" }).getByRole("link", {
					name: "Privacy",
				}),
			).toHaveAttribute("href", "/privacy");
			await expect(
				page.locator('section[aria-label="Product preview"] figure'),
			).toBeVisible();
			await expect(
				page.getByRole("img", { name: /flow into LixRay/ }),
			).toHaveCount(1);

			const hasHorizontalOverflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			);
			expect(hasHorizontalOverflow).toBe(false);
		},
	);
}

test("pricing page lists self-host and managed tiers", async ({ page }) => {
	await page.goto("/pricing");
	await expect(
		page.getByRole("heading", { level: 1, name: "Pricing" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Self-host" })).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "LixRay Managed" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Read the self-host docs" }),
	).toHaveAttribute("href", "/docs/self-host");
});
