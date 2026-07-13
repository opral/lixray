import { expect, test } from "@playwright/test";

test("frontend preview is isolated and supports in-memory directory review", async ({
	page,
}) => {
	const supabaseRequests: Array<string> = [];
	page.on("request", (request) => {
		if (request.url().includes("supabase.co"))
			supabaseRequests.push(request.url());
	});

	await page.goto("/");
	await expect(page.getByText("PR frontend preview")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await expect(page.getByText("Frontend-only preview")).toBeVisible();
	await expect(page.getByText("Connect with Codex")).toHaveCount(0);
	await expect(page.getByRole("link", { name: /launch-q3/ })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /^launch-q3 Frontend-only preview$/ }),
	).toBeVisible();

	await page.getByRole("button", { name: "New workspace" }).click();
	await page
		.getByRole("textbox", { name: "Workspace name" })
		.fill("Preview Draft");
	await page.getByRole("button", { name: "Create workspace" }).click();
	await expect(
		page.getByRole("button", {
			name: /^Preview Draft Frontend-only preview$/,
		}),
	).toBeVisible();

	await page.getByRole("button", { name: "Actions for Preview Draft" }).click();
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await page
		.getByRole("textbox", { name: "Workspace name" })
		.fill("Renamed Preview");
	await page.getByRole("button", { name: "Rename" }).click();
	await expect(
		page.getByRole("button", {
			name: /^Renamed Preview Frontend-only preview$/,
		}),
	).toBeVisible();

	await page
		.getByRole("button", { name: "Actions for Renamed Preview" })
		.click();
	await page.getByRole("menuitem", { name: "Delete workspace…" }).click();
	await page
		.getByRole("textbox", { name: /Type Renamed Preview to confirm/ })
		.fill("Renamed Preview");
	await page.getByRole("button", { name: "Delete workspace" }).click();
	await expect(
		page.getByRole("button", {
			name: /^Renamed Preview Frontend-only preview$/,
		}),
	).toHaveCount(0);

	expect(supabaseRequests).toEqual([]);
});

test("frontend preview rejects backend routes and explains unavailable pages", async ({
	page,
	request,
}) => {
	const response = await request.get("/v1/workspaces/example/branches");
	expect(response.status()).toBe(404);
	expect(await response.json()).toEqual({
		error: {
			code: "PREVIEW_BACKEND_UNAVAILABLE",
			message:
				"This frontend-only PR preview does not include LixRay backend services.",
		},
	});

	await page.goto("/sign-in");
	await expect(
		page.getByRole("heading", { name: "Authentication is unavailable" }),
	).toBeVisible();

	await page.goto("/@acme/launch-q3");
	await expect(
		page.getByRole("heading", { name: "Workspace files is unavailable" }),
	).toBeVisible();
});
