import { randomUUID } from "node:crypto";
import type { Page, Request } from "@playwright/test";
import { expect, expectOk, test } from "./fixtures";
import type { BranchesResponse } from "../../src/lib/lixray-api";
import {
	DEMO_AUTH_TOKEN,
	DEMO_MAIN_BRANCH_ID,
} from "../../src/lib/demo-identity";

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

	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === "/@acme/launch-q3/file/atelier-first-slice.md" &&
			url.searchParams.get("branch") === DEMO_MAIN_BRANCH_ID
		);
	});
	await expect(
		page.getByText("Hello from the SlateDB-backed Atelier"),
	).toBeVisible({
		timeout: 30_000,
	});
	await settlePageExecutes(page, pendingExecutes);

	await page.reload();
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === "/@acme/launch-q3/file/atelier-first-slice.md" &&
			url.searchParams.get("branch") === DEMO_MAIN_BRANCH_ID
		);
	});
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

test("branch URL normalization preserves encoded file names", async ({
	page,
}) => {
	const pendingExecutes = trackPageExecutes(page);
	const filePath = "/encoded path % value.md";
	const markdown = "# Encoded file route\n";
	await seedMarkdownFile(page, filePath, markdown);
	const encodedPath = `/@acme/launch-q3/file/${encodeURIComponent(
		filePath.slice(1),
	)}`;

	await page.goto(encodedPath);

	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === encodedPath &&
			url.searchParams.get("branch") === DEMO_MAIN_BRANCH_ID
		);
	});
	await expect(
		page.getByRole("heading", { name: "Encoded file route" }),
	).toBeVisible({ timeout: 55_000 });
	await settlePageExecutes(page, pendingExecutes);
});

test("a branch-only file survives reload and falls back to the workspace root on main", async ({
	page,
}) => {
	const pendingExecutes = trackPageExecutes(page);
	const { draftBranchId, filePath, mainBranchId } =
		await seedBranchOnlyMarkdownFile(page);
	const encodedPath = `/@acme/launch-q3/file/${encodeURIComponent(
		filePath.slice(1),
	)}`;

	await page.goto(`${encodedPath}?branch=${encodeURIComponent(draftBranchId)}`);
	await expect(
		page.getByRole("heading", { name: "Draft-only file" }),
	).toBeVisible({ timeout: 55_000 });
	await page.reload();
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === encodedPath &&
			url.searchParams.get("branch") === draftBranchId
		);
	});
	await expect(
		page.getByRole("heading", { name: "Draft-only file" }),
	).toBeVisible({ timeout: 55_000 });

	await page.goto(`${encodedPath}?branch=${encodeURIComponent(mainBranchId)}`);
	await expect(page).toHaveURL(
		(url) =>
			url.pathname === "/@acme/launch-q3" &&
			url.searchParams.get("branch") === mainBranchId,
		{ timeout: 55_000 },
	);
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

async function seedMarkdownFile(
	page: Page,
	filePath = FILE_PATH,
	markdown = "# Hello from the SlateDB-backed Atelier\n",
) {
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
					{ kind: "text", value: filePath },
					{
						kind: "blob",
						base64: Buffer.from(markdown).toString("base64"),
					},
				],
			},
		},
	);
	await expectOk(executeResponse);
}

async function seedBranchOnlyMarkdownFile(page: Page): Promise<{
	mainBranchId: string;
	draftBranchId: string;
	filePath: string;
}> {
	const headers = { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` };
	const branchesResponse = await page.request.get(
		`/v1/workspaces/${WORKSPACE_ID}/branches`,
		{ headers },
	);
	await expectOk(branchesResponse);
	const branches = (await branchesResponse.json()) as BranchesResponse;
	const mainBranchId =
		branches.branches.find((branch) => branch.name === "main")?.id ??
		branches.branches[0]?.id;
	expect(mainBranchId).toBeTruthy();
	const draftBranchId = randomUUID();
	const createBranchResponse = await page.request.post(
		`/v1/workspaces/${WORKSPACE_ID}/createBranch`,
		{
			headers,
			data: {
				branchId: mainBranchId,
				id: draftBranchId,
				name: `Draft ${draftBranchId.slice(0, 8)}`,
			},
		},
	);
	await expectOk(createBranchResponse);
	const filePath = `/draft-only-${randomUUID()}.md`;
	const executeResponse = await page.request.post(
		`/v1/workspaces/${WORKSPACE_ID}/execute`,
		{
			headers,
			data: {
				branchId: draftBranchId,
				sql: "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
				params: [
					{ kind: "text", value: filePath },
					{
						kind: "blob",
						base64: Buffer.from("# Draft-only file\n").toString("base64"),
					},
				],
			},
		},
	);
	await expectOk(executeResponse);
	return { mainBranchId, draftBranchId, filePath };
}
