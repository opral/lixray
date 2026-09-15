import { expect, test } from "@playwright/test";
const lixId = "11111111-1111-4111-8111-111111111111";
const markdown =
	"# Public file works\n\n![Public image](./public.svg)\n![Private image](./private.svg)";

// The browser runs the real local SDK and Atelier. Download responses model
// the host API; server authorization and SDK transport are covered separately.
test("Atelier renders downloaded bytes in an isolated local Lix", async ({
	page,
}) => {
	const downloads: string[] = [];
	const protocolRequests: string[] = [];
	page.on("request", (req) => {
		if (new URL(req.url()).pathname.startsWith("/lix/"))
			protocolRequests.push(req.url());
	});
	await page.route("**/api/published/entity?*", async (route) => {
		const path = new URL(route.request().url()).searchParams.get("path");
		await route.fulfill(
			path === "/public.svg"
				? {
						json: {
							id: "44444444-4444-4444-8444-444444444444",
							lixId,
							path,
							kind: "file",
						},
					}
				: { status: 404 },
		);
	});
	await page.route("**/api/published/lix/*/file?*", async (route) => {
		const path = new URL(route.request().url()).searchParams.get("path")!;
		downloads.push(path);
		if (path === "/public.md")
			await route.fulfill({
				body: markdown,
				contentType: "application/octet-stream",
			});
		else if (path === "/public.svg")
			await route.fulfill({
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
				contentType: "application/octet-stream",
			});
		else await route.fulfill({ status: 404 });
	});
	await page.goto("/published.html");
	await expect(
		page.getByRole("heading", { name: "Public file works", exact: true }),
	).toBeVisible({ timeout: 90_000 });
	await expect(page.locator(".atelier-file-view")).toHaveAttribute(
		"data-read-only",
		"true",
	);
	await expect(page.getByRole("link", { name: "Download" })).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByAltText("Public image")
				.evaluate((image) => (image as HTMLImageElement).naturalWidth),
		)
		.toBeGreaterThan(0);
	const inspection = await page.evaluate(() =>
		(
			window as unknown as {
				inspectPublishedFiles(): Promise<{
					rows: { id: string; path: string }[];
				}>;
			}
		).inspectPublishedFiles(),
	);
	expect(inspection.rows.map((row) => row.path)).toEqual([
		"/.lix/README.md",
		"/public.md",
		"/public.svg",
	]);
	expect(inspection.rows.find((row) => row.path === "/public.md")?.id).toBe(
		"22222222-2222-4222-8222-222222222222",
	);
	expect(downloads).toEqual([
		"/public.md",
		"/public.svg",
		"/public.md",
		"/public.svg",
	]);
	expect(protocolRequests).toEqual([]);
	// Mutating the separately opened local instance does not affect the viewer.
	await expect(
		page.getByRole("heading", { name: "Public file works", exact: true }),
	).toBeVisible();
});

for (const status of [426, 503, 404]) {
	test(`download HTTP ${status} retains its meaning`, async ({ page }) => {
		await page.route("**/api/published/lix/*/file?*", (route) =>
			route.fulfill({ status }),
		);
		await page.goto("/published.html");
		await expect(
			page.getByText(
				status === 426
					? /incompatible with the server/
					: status === 503
						? /server could not load/
						: /unavailable or is no longer public/,
			),
		).toBeVisible();
		if (status !== 404)
			await expect(page.getByText(/no longer public/)).toHaveCount(0);
	});
}
