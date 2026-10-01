import { expect, type Page } from "@playwright/test";

export const libraryTab = (page: Page) =>
	page.locator(
		'button[data-view-key="atelier_library"]:is([data-view-instance="library"], [data-view-instance="library-default"])',
	);

export async function showLibraryFiles(page: Page) {
	await page.getByTestId("library-kind-files").waitFor({ timeout: 120_000 });
	await page.getByTestId("library-kind-files").click();
	await expect(page.getByTestId("library-kind-files")).toHaveAttribute(
		"aria-current",
		"page",
		{
			timeout: 120_000,
		},
	);
	const view = page.locator('[data-testid="library-view"]:visible');
	await expect(view).toHaveAttribute("data-library-kind", "files");
	await expect(view).toHaveAttribute("data-library-mode", "folders");
	await expect(view.locator('[role="status"][aria-busy="true"]')).toHaveCount(
		0,
		{ timeout: 120_000 },
	);
	await expect(view.getByRole("alert")).toHaveCount(0);
}

export const libraryRow = (page: Page, name: string) =>
	page
		.getByTestId("library-rows")
		.locator("li[data-path]")
		.filter({
			has: page.getByText(name, { exact: true }),
		});

export const libraryOpenButton = (page: Page, name: string) =>
	libraryRow(page, name).locator("button[draggable]");
