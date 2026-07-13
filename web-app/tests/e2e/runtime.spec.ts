import { expect, expectOk, test } from "./fixtures";
import type {
	BranchesResponse,
	ExecuteResponse,
} from "../../src/lib/lixray-api";
import { DEMO_CREATED_WORKSPACE_ID } from "../../src/lib/demo-identity";

test("sign-in route renders without runtime errors", async ({ page }) => {
	await page.goto("/sign-in");

	await expect(
		page.getByRole("heading", { name: "Sign in to Lixray" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByText(/Microsoft/i)).toHaveCount(0);
});

test("home lists workspaces and opens the canonical workspace route", async ({
	page,
}) => {
	const supabaseRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("supabase.co")) {
			supabaseRequests.push(request.url());
		}
	});
	await page.goto("/");

	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "acme" })).toBeVisible();
	const workspaceLink = page.getByRole("link", { name: /launch-q3/ });
	await expect(workspaceLink).toBeVisible();
	await expect(workspaceLink).toContainText(/\d+ files?/);
	const mcpPrompt = page.locator(
		"section[aria-labelledby='mcp-quickstart-title'] pre",
	);
	await expect(mcpPrompt).toContainText('named "LixRay-Demo"');
	await expect(mcpPrompt).toContainText("demo MCP server is authless");
	await expect(mcpPrompt).not.toContainText("complete its OAuth connection");
	await expect(page.getByRole("heading", { name: "Files" })).toHaveCount(0);

	await page.getByRole("button", { name: "Actions for launch-q3" }).click();
	await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Copy URL" })).toBeVisible();
	await page.keyboard.press("Escape");

	await workspaceLink.click();
	await expect(page).toHaveURL(/\/@acme\/launch-q3$/);
	await expect(
		page.getByRole("button", { name: "Toggle left panel" }),
	).toBeVisible({
		timeout: 55_000,
	});
	await expect(
		page.getByRole("link", { name: "Back to Lixray home" }),
	).toBeVisible();
	expect(supabaseRequests).toEqual([]);
});

test("workspace dialogs inherit Atelier's semantic theme", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await expect(page.getByRole("link", { name: /launch-q3/ })).toContainText(
		/\d+ files?/,
	);
	await page.getByRole("button", { name: "New workspace" }).click();
	await expect(
		page.getByRole("dialog", { name: "New workspace" }),
	).toBeVisible();
	await page.getByRole("textbox", { name: "Workspace name" }).fill("hello");

	const tokens = await page.evaluate(() => {
		const resolveCssValue = (property: string, value: string) => {
			const probe = document.createElement("div");
			probe.style.setProperty(property, value);
			document.body.append(probe);
			const resolved = getComputedStyle(probe).getPropertyValue(property);
			probe.remove();
			return resolved;
		};
		const style = (selector: string) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`Missing ${selector}`);
			const computed = getComputedStyle(element);
			return {
				background: computed.backgroundColor,
				border: computed.borderColor,
				boxShadow: computed.boxShadow,
				color: computed.color,
				font: computed.fontFamily,
			};
		};
		const root = getComputedStyle(document.documentElement);
		return {
			app: style("[data-testid='workspace-directory']"),
			cancel: style("[data-slot='dialog-footer'] [data-variant='outline']"),
			create: style("[data-slot='dialog-footer'] [data-variant='default']"),
			dialog: style("[data-slot='dialog-content']"),
			input: style("[data-testid='workspace-dialog-fields'] input"),
			newWorkspace: style("[data-testid='new-workspace-button']"),
			root: {
				primary: resolveCssValue("color", root.getPropertyValue("--primary")),
				radius: resolveCssValue(
					"border-top-left-radius",
					root.getPropertyValue("--radius"),
				),
				ring: resolveCssValue("color", root.getPropertyValue("--ring")),
			},
		};
	});

	expect(tokens.root).toEqual({
		primary: "rgb(194, 65, 12)",
		radius: "10px",
		ring: "rgb(194, 65, 12)",
	});
	expect(tokens.app.background).toBe("rgb(244, 242, 239)");
	expect(tokens.app.font).toContain("ui-sans-serif");
	expect(tokens.dialog.background).toBe("rgb(255, 255, 255)");
	expect(tokens.dialog.border).toBe("rgb(236, 232, 226)");
	expect(tokens.create.background).toBe("rgb(194, 65, 12)");
	expect(tokens.create.color).toBe("rgb(255, 255, 255)");
	expect(tokens.newWorkspace.background).toBe(tokens.create.background);
	expect(tokens.newWorkspace.color).toBe(tokens.create.color);
	expect(tokens.cancel.border).toBe("rgb(236, 232, 226)");
	expect(tokens.input.boxShadow).toContain("rgb(194, 65, 12)");

	const createButton = page.getByRole("button", { name: "Create workspace" });
	await createButton.hover();
	await expect
		.poll(() =>
			createButton.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			),
		)
		.toBe("rgb(154, 52, 18)");
});

test("creates a workspace, cold-starts its storage, and opens Atelier", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await expect(page.getByRole("link", { name: /launch-q3/ })).toContainText(
		/\d+ files?/,
		{ timeout: 55_000 },
	);

	await page.getByRole("button", { name: "New workspace" }).click();
	await expect(
		page.getByRole("dialog", { name: "New workspace" }),
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Workspace name" })
		.fill("Fresh Workspace");
	const branchesResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes(`/v1/workspaces/${DEMO_CREATED_WORKSPACE_ID}/`) &&
			response.url().endsWith("/branches") &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page.getByRole("button", { name: "Create workspace" }).click();

	const branchesResponse = await branchesResponsePromise;
	await expectOk(branchesResponse);
	await expect(
		page.getByRole("dialog", { name: "New workspace" }),
	).toBeHidden();
	const workspaceLink = page.getByRole("link", { name: /Fresh Workspace/ });
	await expect(workspaceLink).toContainText("0 files");

	await workspaceLink.click();
	await expect(page).toHaveURL(/\/@acme\/fresh-workspace$/);
	await expect(
		page.getByRole("button", { name: "Toggle left panel" }),
	).toBeVisible({
		timeout: 55_000,
	});
	await expect(
		page.getByRole("link", { name: "Back to Lixray home" }),
	).toBeVisible();
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
