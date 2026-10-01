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
