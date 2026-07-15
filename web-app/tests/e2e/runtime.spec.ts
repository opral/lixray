import { expect, expectOk, test } from "./fixtures";
import type {
	BranchesResponse,
	ExecuteResponse,
} from "../../src/lib/lixray-api";
import { DEMO_MAIN_BRANCH_ID } from "../../src/lib/demo-identity";

test("sign-in route renders without runtime errors", async ({ page }) => {
	await page.goto("/sign-in");
	await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
		"content",
		"#f4f2ef",
	);

	await expect(
		page.getByRole("heading", { name: "Sign in to LixRay" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByText(/Microsoft/i)).toHaveCount(0);
});

test("landing page renders and the canonical workspace route opens", async ({
	page,
}) => {
	const supabaseRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("supabase.co")) {
			supabaseRequests.push(request.url());
		}
	});
	await page.goto("/");

	await expect(
		page.getByRole("heading", {
			name: "The shared workspace for your team and AI agents",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "LixRay home" }).first(),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Create workspace free" }),
	).toHaveAttribute("href", "/sign-in");
	await expect(
		page.getByRole("heading", { name: "Your team's agents work in isolation" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "How it works" }),
	).toBeVisible();
	expect(supabaseRequests).toEqual([]);

	await page.goto("/@acme/launch-q3");
	await expect(page).toHaveURL(/\/@acme\/launch-q3$/);
	await expect(
		page.getByRole("button", { name: "Toggle left panel" }),
	).toBeVisible({
		timeout: 55_000,
	});
	await expect(
		page.getByRole("link", { name: "Back to workspaces" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Back to workspaces" }).click();
	await expect(page).toHaveURL(/\/home$/);
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
});

test("sql console loads branches and executes a trivial query", async ({
	page,
}) => {
	const branchesResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes("/v1/workspaces/") &&
			response.url().endsWith("/branches") &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page.goto("/sql");
	const branchesResponse = await branchesResponsePromise;

	await expect(
		page.getByRole("heading", { name: "SQL console" }),
	).toBeVisible();
	const productHeaders = page.locator("header[data-app-titlebar]");
	await expect(productHeaders).toHaveCount(1);
	const titlebarContent = productHeaders.locator("[data-app-titlebar-content]");
	await expect(titlebarContent).toHaveCount(1);
	await expect(
		titlebarContent.getByRole("link", { name: "LixRay home" }),
	).toBeVisible();
	await expect(titlebarContent.getByText("SQL console")).toBeVisible();
	await expectOk(branchesResponse);
	const branchesBody = (await branchesResponse.json()) as BranchesResponse;
	expect(branchesBody.branches, JSON.stringify(branchesBody)).toEqual(
		expect.any(Array),
	);
	expect(
		branchesBody.branches.length,
		JSON.stringify(branchesBody),
	).toBeGreaterThan(0);
	expect(
		branchesBody.branches.find((branch) => branch.name === "main")?.id,
	).toBe(DEMO_MAIN_BRANCH_ID);
	await expect(page.getByText("Loading branches...")).toBeHidden({
		timeout: 50_000,
	});
	await expect(page.getByText("No branches returned.")).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);

	const branches = page.getByTestId("branch-button");
	await expect(branches.first()).toBeVisible();
	expect(await branches.count()).toBeGreaterThan(0);
	await expect(
		page.locator('[data-testid="branch-button"][aria-pressed="true"]'),
	).toBeVisible();

	await page.getByLabel("Statement").fill("SELECT 1 AS one");
	await page.getByLabel("Params").fill("[]");
	await expect(page.getByRole("button", { name: "Execute" })).toBeEnabled();
	const executeResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes("/v1/workspaces/") &&
			response.url().endsWith("/execute") &&
			response.request().method() === "POST",
		{ timeout: 55_000 },
	);
	await page.getByRole("button", { name: "Execute" }).click();
	const executeResponse = await executeResponsePromise;

	await expectOk(executeResponse);
	const executeBody = (await executeResponse.json()) as ExecuteResponse;
	expect(executeBody.columns, JSON.stringify(executeBody)).toEqual(["one"]);
	expect(executeBody.rows, JSON.stringify(executeBody)).toEqual([
		[{ kind: "int", value: 1 }],
	]);
	const result = page.getByTestId("query-result");
	await expect(result).toBeVisible({ timeout: 50_000 });
	await expect(result.getByText("1 rows")).toBeVisible();
	await expect(page.getByTestId("result-table")).toBeVisible();
	await expect(
		page.getByTestId("result-table").getByRole("columnheader", { name: "one" }),
	).toBeVisible();
	await expect(
		page.getByTestId("result-table").getByRole("cell", { name: "1" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("PWA manifest opts into the window controls overlay and serves its icons", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
		"href",
		"/manifest.webmanifest",
	);

	const manifestResponse = await page.request.get("/manifest.webmanifest");
	await expectOk(manifestResponse);
	expect(manifestResponse.headers()["content-type"]).toContain(
		"application/manifest+json",
	);
	const manifest = (await manifestResponse.json()) as {
		display?: unknown;
		display_override?: unknown;
		start_url?: unknown;
		icons?: Array<{
			purpose?: unknown;
			sizes?: unknown;
			src?: unknown;
			type?: unknown;
		}>;
	};
	expect(manifest.start_url).toBe("/open");
	expect(manifest.display_override).toEqual(["window-controls-overlay"]);
	expect(manifest.display).toBe("standalone");
	expect(manifest.icons).toEqual([
		{
			src: "/lixray-icon-192.png",
			sizes: "192x192",
			type: "image/png",
		},
		{
			src: "/lixray-icon-512.png",
			sizes: "512x512",
			type: "image/png",
		},
		{
			src: "/lixray-icon-maskable-192.png",
			sizes: "192x192",
			type: "image/png",
			purpose: "maskable",
		},
		{
			src: "/lixray-icon-maskable-512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "maskable",
		},
	]);

	for (const icon of manifest.icons ?? []) {
		expect(typeof icon.src).toBe("string");
		const iconResponse = await page.request.get(String(icon.src));
		await expectOk(iconResponse);
		expect(iconResponse.headers()["content-type"]).toContain("image/png");
		expect((await iconResponse.body()).byteLength).toBeGreaterThan(0);
	}

	await page.goto(String(manifest.start_url));
	await expect(page).toHaveURL(/\/@acme\/launch-q3$/);
});

test("legacy sign-up routes redirect to Google sign-in", async ({ page }) => {
	const response = await page.goto("/sign-up/verify-email-address");

	expect(response?.status()).not.toBe(404);
	await expect(page).toHaveURL(/\/sign-in$/);
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
});
