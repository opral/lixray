import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
	test(`landing illustrations keep one rail and responsive stacks at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");

		const rails = page.getByRole("img", {
			name: "Claude proposes changes to the repository",
		});
		await expect(rails).toHaveCount(1);

		const illustration = page.locator("figure[role=img]");
		const today = await illustration
			.locator(":scope > div")
			.first()
			.boundingBox();
		const lixray = await illustration
			.locator(":scope > div")
			.last()
			.boundingBox();
		expect(today).not.toBeNull();
		expect(lixray).not.toBeNull();
		if (width >= 640) {
			expect(lixray!.x).toBeGreaterThan(today!.x + today!.width);
		} else {
			expect(lixray!.y).toBeGreaterThan(today!.y + today!.height);
		}
		const hasHorizontalOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		);
		expect(hasHorizontalOverflow).toBe(false);
	});
}
