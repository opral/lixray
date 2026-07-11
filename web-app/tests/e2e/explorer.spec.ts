import { readFileSync } from "node:fs";
import { expect, expectOk, test } from "./fixtures";

test("file explorer supports create, upload, navigate, rename, download, delete", async ({
	page,
}) => {
	const branchesResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes("/v1/workspaces/") &&
			response.url().endsWith("/branches") &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page.goto("/");
	await expectOk(await branchesResponsePromise);

	await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
	await expect(page.getByTestId("explorer-empty")).toBeVisible({
		timeout: 55_000,
	});

	// Create a folder.
	await page.getByRole("button", { name: "New folder" }).click();
	await page.getByRole("dialog").getByLabel("Name").fill("docs");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Create" })
		.click();
	const docsRow = page.getByTestId("entry-row").filter({ hasText: "docs" });
	await expect(docsRow).toBeVisible({ timeout: 55_000 });

	// Upload a file into the current (root) directory.
	await page.getByTestId("upload-file-input").setInputFiles({
		name: "hello.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello lixray"),
	});
	const fileRow = page
		.getByTestId("entry-row")
		.filter({ hasText: "hello.txt" });
	await expect(fileRow).toBeVisible({ timeout: 55_000 });
	await expect(fileRow.getByText("12 B")).toBeVisible();
	await expect(fileRow.getByRole("cell").nth(3)).toContainText(/now|ago/);

	// Navigate into the folder; breadcrumb and URL reflect it.
	await docsRow.getByRole("link", { name: "docs" }).click();
	await expect(page).toHaveURL(/dir=%2Fdocs%2F/);
	await expect(
		page.getByTestId("explorer-breadcrumb").getByText("docs"),
	).toBeVisible();
	await expect(page.getByTestId("explorer-empty")).toBeVisible({
		timeout: 55_000,
	});

	// Back to the root via the breadcrumb.
	await page
		.getByTestId("explorer-breadcrumb")
		.getByRole("link", { name: "Home" })
		.click();
	await expect(fileRow).toBeVisible({ timeout: 55_000 });

	// Rename the file.
	await fileRow.getByRole("button", { name: "Actions for hello.txt" }).click();
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await page.getByRole("dialog").getByLabel("Name").fill("hello2.txt");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Rename" })
		.click();
	const renamedRow = page
		.getByTestId("entry-row")
		.filter({ hasText: "hello2.txt" });
	await expect(renamedRow).toBeVisible({ timeout: 55_000 });

	// Download it and verify the content round-trips.
	const downloadPromise = page.waitForEvent("download");
	await renamedRow
		.getByRole("button", { name: "Actions for hello2.txt" })
		.click();
	await page.getByRole("menuitem", { name: "Download" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("hello2.txt");
	expect(readFileSync(await download.path(), "utf8")).toBe("hello lixray");

	// Delete the folder via its row menu.
	await docsRow.getByRole("button", { name: "Actions for docs" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(docsRow).toHaveCount(0, { timeout: 55_000 });

	// Delete the file through multi-select bulk actions.
	await renamedRow.getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();
	await page.getByRole("button", { name: "Delete" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(page.getByTestId("explorer-empty")).toBeVisible({
		timeout: 55_000,
	});

	await expect(page.getByRole("alert")).toHaveCount(0);
});
