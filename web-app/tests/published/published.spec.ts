import { expect, test } from "@playwright/test";
import { entityRoutePath } from "../../src/lib/entity-url";
const lixId = "11111111-1111-4111-8111-111111111111";
const markdown =
	"# Public file works\n\n![Public image](./public.svg)\n![Private image](./private.svg)\n\n[Next public file](./next.md#setup) · [Docs](/docs)";

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
	await page.route("**/@opral/fixture/file/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/published-fixture.tsx"></script></body></html>',
		}),
	);
	await page.route("**/api/published/entity?*", async (route) => {
		const path = new URL(route.request().url()).searchParams.get("path");
		await route.fulfill(
			path === "/public.svg" || path === "/next.md"
				? {
						json: {
							id:
								path === "/public.svg"
									? "44444444-4444-4444-8444-444444444444"
									: "55555555-5555-4555-8555-555555555555",
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
		else if (path === "/next.md")
			await route.fulfill({
				body: "# Next file\n\n## Setup\n\nPublished destination.",
				contentType: "application/octet-stream",
			});
		else await route.fulfill({ status: 404 });
	});
	await page.goto("/published.html");
	await expect(
		page.getByRole("heading", { name: "Public file works", exact: true }),
	).toBeVisible({ timeout: 90_000 });
	await expect(
		page.getByRole("button", { name: "Toggle left panel" }),
	).toBeVisible();
	await expect(page.getByText("Public · read-only")).toBeVisible();
	await expect(page.locator(".ProseMirror")).toHaveAttribute(
		"contenteditable",
		"false",
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
	const linkedUrl = new URL(
		entityRoutePath(
			"opral",
			"fixture",
			"file",
			"55555555-5555-4555-8555-555555555555",
			"/next.md",
		),
		page.url(),
	).href;
	await page.getByRole("link", { name: "Next public file" }).click();
	await expect(page).toHaveURL(`${linkedUrl}#setup`);
	await expect(page.getByRole("heading", { name: "Next file" })).toBeVisible({
		timeout: 90_000,
	});
	await page.goBack();
	await expect(page).toHaveURL(/\/published\.html$/);
	await expect(
		page.getByRole("heading", { name: "Public file works" }),
	).toBeVisible({ timeout: 90_000 });
	await page.getByRole("link", { name: "Docs" }).click();
	await expect(page).toHaveURL(/\/docs$/);
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

test("a crafted link fallback cannot redirect outside the site", async ({
	page,
}) => {
	await page.route("**/api/published/entity?*", (route) =>
		route.fulfill({ status: 404 }),
	);
	await page.route("**/api/published/lix/*/file?*", (route) =>
		route.fulfill({
			body: "# Public",
			contentType: "application/octet-stream",
		}),
	);
	await page.goto(
		"/published.html#published-file=%2Fmissing&fallback=%2F%5Cevil.com",
	);
	await expect(page.getByText(/linked file is unavailable/)).toBeVisible();
	await expect(page).toHaveURL(/\/published\.html#published-file=/);
});
