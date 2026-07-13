import type { Page, Request } from "@playwright/test";
import { expect, expectOk, test } from "./fixtures";
import type { BranchesResponse } from "../../src/lib/lixray-api";
import { DEMO_AUTH_TOKEN } from "../../src/lib/demo-identity";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const FILE_PATH = "/atelier-first-slice.md";

test("Atelier renders the remote workspace and keeps file navigation in its host", async ({
	page,
}) => {
	const pendingExecutes = trackPageExecutes(page);
	await seedMarkdownFile(page);
	await page.goto("/@acme/launch-q3");

	const file = page.getByRole("treeitem", {
		name: "atelier-first-slice.md",
	});
	await expect(file).toBeVisible({ timeout: 55_000 });
	await file.click();

	await expect(page).toHaveURL(
		/\/@acme\/launch-q3\/file\/atelier-first-slice\.md$/,
	);
	await expect(
		page.getByText("Hello from the SlateDB-backed Atelier"),
	).toBeVisible({
		timeout: 30_000,
	});
	await settlePageExecutes(page, pendingExecutes);

	await page.reload();
	await expect(page).toHaveURL(
		/\/@acme\/launch-q3\/file\/atelier-first-slice\.md$/,
	);
	await expect(
		page.getByText("Hello from the SlateDB-backed Atelier"),
	).toBeVisible({
		timeout: 55_000,
	});
	await expect(
		page.getByRole("link", { name: "Back to Lixray home" }),
	).toBeVisible();
	await settlePageExecutes(page, pendingExecutes);
});

function trackPageExecutes(page: Page): Set<Request> {
	const requests = new Set<Request>();
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/execute")
		) {
			requests.add(request);
		}
	});
	page.on("requestfinished", (request) => requests.delete(request));
	page.on("requestfailed", (request) => requests.delete(request));
	return requests;
}

async function settlePageExecutes(page: Page, requests: Set<Request>) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await expect.poll(() => requests.size).toBe(0);
}

async function seedMarkdownFile(page: Page) {
	const headers = { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` };
	const branchesResponse = await page.request.get(
		`/v1/workspaces/${WORKSPACE_ID}/branches`,
		{ headers },
	);
	await expectOk(branchesResponse);
	const branches = (await branchesResponse.json()) as BranchesResponse;
	const branchId =
		branches.branches.find((branch) => branch.name === "main")?.id ??
		branches.branches[0]?.id;
	expect(branchId).toBeTruthy();

	const executeResponse = await page.request.post(
		`/v1/workspaces/${WORKSPACE_ID}/execute`,
		{
			headers,
			data: {
				branchId,
				sql: "INSERT INTO lix_file (path, data) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET data = excluded.data",
				params: [
					{ kind: "text", value: FILE_PATH },
					{
						kind: "blob",
						base64: Buffer.from(
							"# Hello from the SlateDB-backed Atelier\n",
						).toString("base64"),
					},
				],
			},
		},
	);
	await expectOk(executeResponse);
}
