import { readFile } from "node:fs/promises";
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

test("exports saved work and its recovery limitations without creating a branch", async ({
	page,
}) => {
	await page.goto("/recovery.html");
	await expect(
		page.getByRole("button", { name: "Restore to recovery branches" }),
	).toHaveCount(0);
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery data" }).click();
	const downloaded = await download;
	expect(downloaded.suggestedFilename()).toBe("lix-recovery-repo-legacy.json");
	const data: unknown = JSON.parse(
		await readFile((await downloaded.path())!, "utf8"),
	);
	expect(data).toMatchObject({
		source: { id: "legacy" },
		unresolved: ["Local-only value preserved"],
	});
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
		page.getByRole("button", { name: "Download recovery data" }),
	).toBeVisible();
	await expect(
		page.getByText("Current repository remains usable"),
	).toBeVisible();
});

test("a failed export can be retried", async ({ page }) => {
	await page.goto("/recovery.html?mode=export-error");
	await page.getByRole("button", { name: "Download recovery data" }).click();
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
	await page.getByRole("button", { name: "Download recovery data" }).click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await page.getByRole("button", { name: "Finish old download" }).click();
	await expect(
		page.getByRole("complementary", { name: "Saved device changes" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Download recovery data" }),
	).toHaveCount(0);
});

test("switching back releases controls while an old download is pending", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=delayed");
	await page.getByRole("button", { name: "Download recovery data" }).click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await page.getByRole("button", { name: "Switch account" }).click();
	await expect(
		page.getByRole("button", { name: "Download recovery data" }),
	).toBeEnabled();
});

test("occupied storage explains safe recovery and retry leaves the error screen", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=storage-busy");
	await expect(page.getByRole("alert")).toContainText(
		"Close its other tabs and windows, then retry",
	);
	await expect(page.getByRole("alert")).toContainText(
		"Your saved local changes will be kept",
	);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("status")).toHaveText("Opening repository");
});

test("opening errors keep their diagnostic and can retry without lock recovery", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=open-error");
	await expect(page.getByRole("alert")).toContainText(
		"Unrelated opening error",
	);
	await expect(page.getByRole("alert")).not.toContainText(
		"Close its other tabs and windows",
	);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("status")).toHaveText("Opening repository");
});

test("reset and its error stay in the main view without storage panels", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=device-reset-error");
	const main = page.getByRole("main");
	await expect(
		main.getByRole("button", { name: "Reset from server", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("complementary")).toHaveCount(0);
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await expect(page.getByText("Saved device copies")).toHaveCount(0);
	await main
		.getByRole("button", { name: "Reset from server", exact: true })
		.click();
	await expect(main).toContainText("another tab owns");
	await expect(
		main.getByRole("button", { name: "Reset from server", exact: true }),
	).toBeEnabled();
});
test("successful reset reloads into the new replica flow", async ({ page }) => {
	await page.goto("/recovery.html?mode=device-reset-success");
	await page
		.getByRole("main")
		.getByRole("button", { name: "Reset from server", exact: true })
		.click();
	await expect(page.getByText("Fresh replica opening")).toBeVisible();
});
test("a healthy replica has no device recovery controls", async ({ page }) => {
	await page.goto("/recovery.html?mode=device-reset-healthy");
	await expect(
		page.getByRole("button", { name: "Reset from server", exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("protocol update action reloads the document instead of retrying the old client", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=client-update");
	await expect(
		page.getByRole("button", { name: "Retry", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Reload LixRay" }).click();
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem("fixture-loads")))
		.toBe("2");
});
test("retry cannot interrupt an in-flight reset transaction", async ({
	page,
}) => {
	await page.goto("/recovery.html?mode=reset-busy");
	await expect(
		page.getByRole("button", { name: "Reset in progress…" }),
	).toBeDisabled();
	await expect(page.getByRole("status")).toHaveCount(0);
});
