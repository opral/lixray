import { expect, test } from "@playwright/test";

test("acknowledged copies do not create a recovery task", async ({ page }) => {
	await page.goto("/recovery.html?mode=clean");
	await expect(
		page.getByText("Current repository remains usable"),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Saved device changes" }),
	).toHaveCount(0);
});

test("restores for review and exports without hiding unresolved work", async ({
	page,
}) => {
	await page.goto("/recovery.html");
	await page
		.getByRole("button", { name: "Restore to recovery branches" })
		.click();
	await expect(
		page.getByText("Recovery branches are ready for review.", { exact: false }),
	).toBeVisible();
	await page.getByRole("button", { name: "Review recovery branch 1" }).click();
	await expect(page.locator("output")).toHaveText("recovered-branch");
	await page.getByText("Some saved content still needs recovery").click();
	await expect(
		page.getByText("A local-only value remains on this device"),
	).toBeVisible();
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery data" }).click();
	expect((await download).suggestedFilename()).toBe(
		"lix-recovery-repo-legacy.json",
	);
	await expect(
		page.getByRole("complementary", { name: "Saved device changes" }),
	).toBeVisible();
});

test("listing errors can retry without preventing repository access", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=list-error");
	await expect(page.getByRole("alert")).toContainText("Device storage is busy");
	await page.getByRole("button", { name: "Check again" }).click();
	await expect(
		page.getByRole("button", { name: "Restore to recovery branches" }),
	).toBeVisible();
	await expect(
		page.getByText("Current repository remains usable"),
	).toBeVisible();
});

test("a failed restoration keeps export available", async ({ page }) => {
	await page.goto("/recovery.html?mode=recover-error");
	await page
		.getByRole("button", { name: "Restore to recovery branches" })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Saved content is not available yet",
	);
	await expect(
		page.getByRole("button", { name: "Download recovery data" }),
	).toBeEnabled();
});

test("old asynchronous results do not appear after switching account", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=delayed");
	await page
		.getByRole("button", { name: "Restore to recovery branches" })
		.click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await page.getByRole("button", { name: "Finish old recovery" }).click();
	await expect(
		page.getByRole("complementary", { name: "Saved device changes" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Review recovery branch 1" }),
	).toHaveCount(0);
});

test("switching back releases controls while an old recovery is pending", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=delayed");
	await page
		.getByRole("button", { name: "Restore to recovery branches" })
		.click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await expect(
		page.getByRole("button", { name: "Restore to recovery branches" }),
	).toBeEnabled();
});
