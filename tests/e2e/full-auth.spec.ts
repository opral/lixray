import type { Page, Response } from "@playwright/test";
import { expect, expectOk, test } from "./fixtures";

test("full-auth user can create and open a fresh workspace", async ({
	page,
}) => {
	const workspaceName = `E2E ${Date.now().toString(36)}`;
	const workspaceSlug = workspaceName.toLowerCase().replace(/\s+/g, "-");
	const branchResponses = new Map<string, Response>();
	let created = false;

	page.on("response", (response) => {
		const match = /\/v1\/workspaces\/([^/]+)\/branches$/.exec(response.url());
		if (match?.[1]) branchResponses.set(match[1], response);
	});

	try {
		await page.goto("/sign-in");
		const localSignIn = page.getByRole("button", {
			name: "Continue as local developer",
		});
		if (await localSignIn.isVisible()) {
			await localSignIn.click();
		} else {
			await page.getByRole("link", { name: "Continue to Lixray" }).click();
		}

		await expect(page).toHaveURL(/\/$/);
		await expect(
			page.getByRole("heading", { name: "Workspaces" }),
		).toBeVisible();
		await page.getByRole("button", { name: "New workspace" }).click();
		await page
			.getByRole("textbox", { name: "Workspace name" })
			.fill(workspaceName);

		const insertResponsePromise = page.waitForResponse(
			(response) =>
				response.url().includes("/rest/v1/workspaces") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Create workspace" }).click();
		const insertResponse = await insertResponsePromise;
		await expectOk(insertResponse);
		const inserted: unknown = await insertResponse.json();
		const workspaceId = readWorkspaceId(inserted);
		created = true;

		await expect
			.poll(() => branchResponses.get(workspaceId)?.status(), {
				timeout: 55_000,
			})
			.toBe(200);
		const workspaceLink = page.getByRole("link", { name: workspaceName });
		await expect(workspaceLink).toContainText("0 files");

		await workspaceLink.click();
		await expect(page).toHaveURL(new RegExp(`/@acme/${workspaceSlug}$`));
		await expect(
			page.getByRole("button", { name: "Toggle left panel" }),
		).toBeVisible({
			timeout: 55_000,
		});
	} finally {
		if (created) await deleteWorkspaceThroughUi(page, workspaceName);
	}
});

function readWorkspaceId(payload: unknown): string {
	let value: unknown = payload;
	if (Array.isArray(payload)) {
		value = (payload as unknown[])[0];
	}
	if (!value || typeof value !== "object" || !("id" in value)) {
		throw new Error("Workspace insert did not return an id");
	}
	const id: unknown = (value as Record<string, unknown>).id;
	if (typeof id !== "string") {
		throw new Error("Workspace insert returned an invalid id");
	}
	return id;
}

async function deleteWorkspaceThroughUi(page: Page, workspaceName: string) {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	const actions = page.getByRole("button", {
		name: `Actions for ${workspaceName}`,
	});
	await expect(actions).toBeVisible();
	await actions.click();
	await page.getByRole("menuitem", { name: "Delete workspace…" }).click();
	const dialog = page.getByRole("dialog", {
		name: `Delete ${workspaceName}?`,
	});
	await dialog.getByRole("textbox").fill(workspaceName);
	const deleteResponsePromise = page.waitForResponse(
		(response) =>
			response.url().includes("/rest/v1/rpc/delete_workspace") &&
			response.request().method() === "POST",
	);
	await dialog.getByRole("button", { name: "Delete workspace" }).click();
	await expectOk(await deleteResponsePromise);
	await expect(dialog).toBeHidden();
	await expect(actions).toHaveCount(0);
}
