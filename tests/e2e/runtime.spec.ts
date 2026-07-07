import {
	expect,
	test as base,
	type Page,
	type Response,
} from "@playwright/test";

const test = base.extend<{ runtimeErrors: Array<string> }>({
	runtimeErrors: [
		async ({ page }, use) => {
			const errors: Array<string> = [];

			page.on("pageerror", (error) => {
				errors.push(error.stack ?? error.message);
			});
			page.on("console", (message) => {
				if (message.type() === "error") {
					errors.push(`console error: ${message.text()}`);
				}
			});

			await use(errors);
			await expectNoViteOverlay(page);
			expect(errors).toEqual([]);
		},
		{ auto: true },
	],
});

test("sign-in route renders without runtime errors", async ({ page }) => {
	await page.goto("/sign-in");

	await expect(page.locator(".auth-card")).toBeVisible();
});

test("dashboard loads branches and executes a trivial query", async ({ page }) => {
	const branchesResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes("/v1/branches") &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page.goto("/");
	const branchesResponse = await branchesResponsePromise;

	await expect(
		page.getByRole("heading", { name: "Workspace database" }),
	).toBeVisible();
	await expectOk(branchesResponse);
	const branchesBody = await branchesResponse.json();
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
			response.url().includes("/v1/execute") &&
			response.request().method() === "POST",
		{ timeout: 55_000 },
	);
	await page.getByRole("button", { name: "Execute" }).click();
	const executeResponse = await executeResponsePromise;

	await expectOk(executeResponse);
	const executeBody = await executeResponse.json();
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

test("nested Clerk sign-up routes are handled by Start", async ({ page }) => {
	const response = await page.goto("/sign-up/verify-email-address");

	expect(response?.status()).not.toBe(404);
	await expect(page.getByText("Not Found")).toHaveCount(0);
});

async function expectOk(response: Response) {
	const summary = response.ok() ? "" : await responseSummary(response);
	expect(response.ok(), summary).toBe(true);
}

async function responseSummary(response: Response) {
	return `${response.status()}: ${(await response.text()).slice(0, 500)}`;
}

async function expectNoViteOverlay(page: Page) {
	const overlay = page.locator("vite-error-overlay");
	if ((await overlay.count()) === 0) {
		return;
	}

	const overlayText = await overlay.first().evaluate((element) => {
		const text = element.shadowRoot?.textContent ?? element.textContent ?? "";
		return text.replace(/\s+/g, " ").trim();
	});
	throw new Error(`Vite error overlay was shown:\n${overlayText}`);
}
