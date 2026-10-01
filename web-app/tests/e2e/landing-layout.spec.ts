import { expect, test } from "@playwright/test";

for (const width of [1440, 390, 320]) {
	test(
		"landing review preview and one rail fit at " + width + "px",
		async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/");

			await expect(
				page.getByRole("heading", {
					name: "A shared repository for your company’s data and AI agents.",
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
				page.getByRole("img", {
					name: /Claude proposes changes to a repository, checks pass, and the changes are accepted/,
				}),
			).toHaveCount(1);

			const panes = page.locator(
				'section[aria-label="Repository preview"] figure > div > div',
			);
			await expect(panes).toHaveCount(2);
			const files = await panes.nth(0).boundingBox();
			const proposal = await panes.nth(1).boundingBox();
			expect(files).not.toBeNull();
			expect(proposal).not.toBeNull();
			if (width >= 640) {
				expect(proposal!.x).toBeGreaterThan(files!.x + files!.width - 1);
			} else {
				expect(proposal!.y).toBeGreaterThan(files!.y + files!.height - 1);
			}
			const hasHorizontalOverflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			);
			expect(hasHorizontalOverflow).toBe(false);
		},
	);
}
