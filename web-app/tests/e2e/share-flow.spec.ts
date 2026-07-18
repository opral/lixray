import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

const WORKSPACE_PATH = "/@acme/launch-q3";

test("a preview test account can share an edit link and a fresh recipient can join", async ({
	browser,
	page: owner,
}) => {
	await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await owner.goto(`/sign-in?returnTo=${encodeURIComponent(WORKSPACE_PATH)}`);
	await owner.getByRole("button", { name: "Continue as preview user" }).click();
	await expect(owner).toHaveURL(new RegExp(`${WORKSPACE_PATH}$`));
	await expect(owner.getByRole("button", { name: "Share" })).toBeVisible({
		timeout: 55_000,
	});

	await owner.getByRole("button", { name: "Share" }).click();
	const editableLink = owner.getByRole("textbox", {
		name: /^Editable link:/,
	});
	await expect(editableLink).toBeVisible();
	const sharedUrl = await editableUrl(editableLink);
	await owner.getByRole("button", { name: "Copy link" }).click();
	await expect(owner.getByRole("button", { name: "Copied" })).toBeVisible();

	const recipientContext = await browser.newContext();
	const recipient = await recipientContext.newPage();
	try {
		await recipient.goto(sharedUrl);
		await expect(recipient).toHaveURL(new RegExp(`${WORKSPACE_PATH}$`));
		await expect(recipient.getByText("Read-only", { exact: true })).toBeVisible(
			{
				timeout: 55_000,
			},
		);
		await expect(
			recipient.getByText("shared by Preview test account", { exact: false }),
		).toBeVisible();
		await expect(recipient.getByRole("button", { name: "Share" })).toHaveCount(
			0,
		);
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
