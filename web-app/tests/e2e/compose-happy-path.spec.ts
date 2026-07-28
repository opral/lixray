import { expect, test } from "@playwright/test";

test("local OAuth consent uses the seeded development account", async ({
	page,
}) => {
	await page.goto("/oauth/consent");
	await expect(
		page.getByText("The authorization request is missing its identifier."),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toHaveCount(0);
});
