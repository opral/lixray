import type { Page, Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ExecuteResponse } from "../../src/lib/lixray-api";

test("local browser path reaches Lix through Compose", async ({ page }) => {
	test.setTimeout(180_000);
	const workspaceName = `Compose E2E ${Date.now().toString(36)}`;
	let workspaceCreated = false;

	try {
		await page.goto("/sign-in");
		await page
			.getByRole("button", { name: "Continue as local developer" })
			.click();
		await expect(page).toHaveURL(/\/home$/);
		await expect(
			page.getByRole("heading", { name: "Workspaces" }),
		).toBeVisible();

		await page.getByRole("button", { name: "New workspace" }).click();
		const dialog = page.getByRole("dialog", { name: "New workspace" });
		await dialog
			.getByRole("textbox", { name: "Workspace name" })
			.fill(workspaceName);
		const insertedWorkspace = page.waitForResponse(
			(response) =>
				response.url().includes("/rest/v1/workspaces") &&
				response.request().method() === "POST",
		);
		await dialog.getByRole("button", { name: "Create workspace" }).click();
		const inserted = await insertedWorkspace;
		expect(inserted.status()).toBe(201);
		expect(await inserted.text()).toBe("");
		workspaceCreated = true;

		const workspaceLink = page.getByRole("link", { name: workspaceName });
		await expect(workspaceLink).toBeVisible();
		const href = await workspaceLink.getAttribute("href");
		expect(href).toBeTruthy();
		const workspacePath = new URL(href ?? "/", page.url()).pathname;
		expect(workspacePath).toMatch(/^\/@[^/]+\/[^/]+$/);

		const handshake = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `${workspacePath}/lix/v1/` &&
				response.request().method() === "GET",
			{ timeout: 55_000 },
		);
		await workspaceLink.click();
		const handshakeResponse = await handshake;
		await expectOk(handshakeResponse);
		const handshakeBody = (await handshakeResponse.json()) as {
			protocolVersion?: unknown;
			activeBranchId?: unknown;
		};
		expect(handshakeBody.protocolVersion).toBe(1);
		expect(handshakeBody.activeBranchId).toEqual(expect.any(String));
		await expect(
			page.getByRole("button", { name: "Toggle left panel" }),
		).toBeVisible({ timeout: 55_000 });

		await page.goto("/sql");
		await expect(
			page.getByRole("heading", { name: "SQL console" }),
		).toBeVisible();
		await expect(page.getByTestId("branch-button").first()).toBeVisible({
			timeout: 55_000,
		});

		await page.getByLabel("Statement").fill("SELECT 1 AS one");
		await page.getByLabel("Params").fill("[]");
		const execution = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
					`${workspacePath}/lix/v1/execute` &&
				response.request().method() === "POST",
			{ timeout: 55_000 },
		);
		await page.getByRole("button", { name: "Execute" }).click();
		const executionResponse = await execution;
		await expectOk(executionResponse);
		expect((await executionResponse.json()) as ExecuteResponse).toEqual({
			columns: ["one"],
			rows: [[{ kind: "int", value: 1 }]],
			rowsAffected: 0,
			notices: [],
		});
		await expect(page.getByTestId("result-table")).toContainText("1");
	} finally {
		if (workspaceCreated) await deleteWorkspaceThroughUi(page, workspaceName);
	}
});

async function expectOk(response: Response) {
	const body = response.ok() ? "" : await response.text();
	expect(response.ok(), `${response.status()}: ${body.slice(0, 500)}`).toBe(
		true,
	);
}

async function deleteWorkspaceThroughUi(page: Page, workspaceName: string) {
	await page.goto("/home");
	const actions = page.getByRole("button", {
		name: `Actions for ${workspaceName}`,
	});
	await expect(actions).toBeVisible({ timeout: 55_000 });
	await actions.click();
	await page.getByRole("menuitem", { name: "Delete workspace…" }).click();
	const dialog = page.getByRole("dialog", {
		name: `Delete ${workspaceName}?`,
	});
	await dialog.getByRole("textbox").fill(workspaceName);
	const deleted = page.waitForResponse(
		(response) =>
			response.url().includes("/rest/v1/rpc/delete_workspace") &&
			response.request().method() === "POST",
	);
	await dialog.getByRole("button", { name: "Delete workspace" }).click();
	await expectOk(await deleted);
	await expect(dialog).toBeHidden();
}
