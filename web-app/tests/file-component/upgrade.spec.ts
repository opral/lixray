import { expect, test } from "@playwright/test";

test("repository upgrade is accessible, indeterminate, and respects reduced motion", async ({
	page,
}, testInfo) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/upgrade.html");
	await expect(page.getByRole("status")).toHaveText("Upgrading repository…");
	const progress = page.getByRole("progressbar", {
		name: "Upgrading repository",
	});
	await expect(progress).toBeVisible();
	await expect(progress).not.toHaveAttribute("aria-valuenow");
	await expect(progress.locator("div")).toHaveCSS("animation-name", "none");
	await expect(page.getByText(/from v\d|to v\d/)).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("repository-upgrade.png"),
	});
});
