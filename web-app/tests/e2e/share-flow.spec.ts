import type { Locator, Page } from "@playwright/test";
import type { BranchesResponse } from "../../src/lib/lixray-api";
import { DEMO_AUTH_TOKEN } from "../../src/lib/demo-identity";
import { expect, expectOk, test } from "./fixtures";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ROOT = "/@acme/launch-q3";
const WORKSPACE_PATH = "/@acme/launch-q3/file/hello.md";

test("a preview test account can share an edit link and a fresh recipient can join", async ({
	browser,
	page: owner,
}) => {
	await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await owner.goto(`/sign-in?returnTo=${encodeURIComponent(WORKSPACE_ROOT)}`);
	await owner.getByRole("button", { name: "Continue as preview user" }).click();
	await expect(owner).toHaveURL(new RegExp(`${WORKSPACE_ROOT}$`));
	await seedMarkdownFile(owner);
	await owner.goto(WORKSPACE_PATH);
	await expect(owner).toHaveURL(new RegExp(`${WORKSPACE_PATH}$`));
	await expect(owner.getByRole("button", { name: "Share" })).toBeVisible({
		timeout: 55_000,
	});

	await owner.getByRole("button", { name: "Share" }).click();
	await expect(
		owner.getByRole("heading", { name: "Share hello.md" }),
	).toBeVisible();
	const editableLink = owner.getByRole("textbox", {
		name: /^Editable link:/,
	});
	await expect(editableLink).toBeVisible();
	const sharedUrl = await editableUrl(editableLink);
	await expect(editableLink.locator("mark")).toHaveCount(0);
	await owner.getByRole("button", { name: "Copy link" }).click();
	await expect(owner.getByRole("button", { name: "Copied" })).toBeVisible();

	const recipientContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
	});
	const recipient = await recipientContext.newPage();
	try {
		await recipient.goto(sharedUrl);
		await expect(recipient).toHaveURL(new RegExp(`${WORKSPACE_PATH}$`));
		await expect
			.poll(() =>
				recipient.evaluate(() =>
					window.sessionStorage.getItem("lixray.workspace-share.pending"),
				),
			)
			.not.toBeNull();
		await expect(recipient.getByText("Read-only", { exact: true })).toBeVisible(
			{
				timeout: 55_000,
			},
		);
		const readOnlyStrip = recipient.getByRole("status").filter({
			hasText: "shared by",
		});
		await expect(readOnlyStrip).toBeVisible();
		await expect(readOnlyStrip).toContainText("Preview test account");
		await expect(recipient.getByRole("button", { name: "Share" })).toHaveCount(
			0,
		);
		await expect(
			recipient.getByRole("button", { name: "Sign in" }),
		).toHaveAttribute("data-size", "xs");
		await expect(
			recipient.getByRole("button", { name: "Join to edit" }),
		).toHaveAttribute("data-size", "xs");
		// The read view stays pristine: no formatting toolbar for readers.
		await expect(
			recipient.getByRole("toolbar", { name: "Formatting toolbar" }),
		).toHaveCount(0);
		await recipient.getByRole("button", { name: "Join to edit" }).click();
		await expect(recipient).toHaveURL(/\/sign-in\?returnTo=/);
		await recipient
			.getByRole("button", { name: "Join as preview user" })
			.click();
		await expect(recipient).toHaveURL(new RegExp(`${WORKSPACE_PATH}$`));
		await expect(recipient.getByRole("button", { name: "Share" })).toBeVisible({
			timeout: 55_000,
		});
	} finally {
		await recipientContext.close();
	}
});

async function seedMarkdownFile(page: Page) {
	const headers = { Authorization: `Bearer ${DEMO_AUTH_TOKEN}` };
	const branchesResponse = await page.request.get(
		`/v1/workspaces/${WORKSPACE_ID}/branches`,
		{ headers },
	);
	await expectOk(branchesResponse);
	const branches = (await branchesResponse.json()) as BranchesResponse;
	const branchId = branches.currentBranchId;
	expect(branchId).toBeTruthy();

	const executeResponse = await page.request.post(
		`/v1/workspaces/${WORKSPACE_ID}/execute`,
		{
			headers,
			data: {
				branchId,
				sql: "INSERT INTO lix_file (path, data) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET data = excluded.data",
				params: [
					{ kind: "text", value: "/hello.md" },
					{
						kind: "blob",
						base64: Buffer.from("# Hello\n").toString("base64"),
					},
				],
			},
		},
	);
	await expectOk(executeResponse);
}

async function editableUrl(link: Locator) {
	const label = await link.getAttribute("aria-label");
	if (!label?.startsWith("Editable link: ")) {
		throw new Error("The share popover did not render an editable link.");
	}
	const value = label.slice("Editable link: ".length);
	if (!value.includes("?invite=")) {
		throw new Error("The share popover did not render an invite capability.");
	}
	return value;
}
