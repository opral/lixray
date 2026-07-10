import { expect, expectOk, test } from "./fixtures";
import type {
	BranchesResponse,
	ExecuteResponse,
} from "../../src/lib/lixray-api";

test("sign-in route renders without runtime errors", async ({ page }) => {
	await page.goto("/sign-in");

	await expect(page.locator(".auth-card")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByText(/Microsoft/i)).toHaveCount(0);
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
	await expectOk(branchesResponse);
	const branchesBody = (await branchesResponse.json()) as BranchesResponse;
	expect(branchesBody.branches, JSON.stringify(branchesBody)).toEqual(
		expect.any(Array),
	);
	expect(
		branchesBody.branches.length,
		JSON.stringify(branchesBody),
	).toBeGreaterThan(0);
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

test("legacy sign-up routes redirect to Google sign-in", async ({ page }) => {
	const response = await page.goto("/sign-up/verify-email-address");

	expect(response?.status()).not.toBe(404);
	await expect(page).toHaveURL(/\/sign-in$/);
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
});
