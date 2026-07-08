import {
	expect,
	test as base,
	type Page,
	type Response,
} from "@playwright/test";

export const test = base.extend<{ runtimeErrors: Array<string> }>({
	runtimeErrors: [
		async ({ page }, use) => {
			const errors: Array<string> = [];

			page.on("pageerror", (error) => {
				errors.push(error.stack ?? error.message);
			});
			page.on("console", (message) => {
				if (message.type() === "error") {
					errors.push(`console error: ${message.text()}`);
				}
			});

			await use(errors);
			await expectNoViteOverlay(page);
			expect(errors).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

export async function expectOk(response: Response) {
	const summary = response.ok() ? "" : await responseSummary(response);
	expect(response.ok(), summary).toBe(true);
}

async function responseSummary(response: Response) {
	return `${response.status()}: ${(await response.text()).slice(0, 500)}`;
}

async function expectNoViteOverlay(page: Page) {
	const overlay = page.locator("vite-error-overlay");
	if ((await overlay.count()) === 0) {
		return;
	}

	const overlayText = await overlay.first().evaluate((element) => {
		const text = element.shadowRoot?.textContent ?? element.textContent ?? "";
		return text.replace(/\s+/g, " ").trim();
	});
	throw new Error(`Vite error overlay was shown:\n${overlayText}`);
}
