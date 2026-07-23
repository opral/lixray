import type { Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ExecuteResponse } from "../../src/lib/lixray-api";

test("local browser path reaches Lix through Compose", async ({ page }) => {
	test.setTimeout(180_000);

	await page.goto("/sign-in");
	const handshake = page.waitForResponse(
		(response) =>
			/^\/@[^/]+\/[^/]+\/lix\/v1\/$/.test(new URL(response.url()).pathname) &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page
		.getByRole("button", { name: "Continue as local developer" })
		.click();
	await expect(page).toHaveURL(/\/@[^/]+\/[^/]+$/);
	const lixPath = new URL(page.url()).pathname;

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
			new URL(response.url()).pathname === `${lixPath}/lix/v1/execute` &&
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
});

async function expectOk(response: Response) {
	const body = response.ok() ? "" : await response.text();
	expect(response.ok(), `${response.status()}: ${body.slice(0, 500)}`).toBe(
		true,
	);
}
