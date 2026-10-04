import { test } from "@playwright/test";
import { createSyncFixture } from "./sync-fixture";

test("warm OPFS reopen latency and query budgets", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(300_000);
	const fixture = await createSyncFixture({
		browser,
		baseURL,
		scenario: "performance",
	});
	let primaryFailure: unknown;
	try {
		const state = await fixture.editing();
		const reopened = await fixture.reopen(state);
		await fixture.history(reopened);
	} catch (error) {
		primaryFailure = error;
		throw error;
	} finally {
		await fixture.close(primaryFailure);
	}
});
