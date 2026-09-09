import { test } from "@playwright/test";
import { createSyncFixture } from "./sync-fixture";

// The demo UI resolves two fixed repository IDs. Each scenario seeds its own
// prerequisites on the disposable stack; serialize writes to those fixtures.
test.describe.configure({ mode: "default" });

test("@navigation repository navigation preserves every configured entry point", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(180_000);
	const fixture = await createSyncFixture({
		browser,
		baseURL,
		scenario: "navigation",
	});
	try {
		await fixture.navigation();
	} finally {
		await fixture.close();
	}
});

test("@editing shared OPFS tabs edit in both directions and converge with an independent replica", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(240_000);
	const fixture = await createSyncFixture({
		browser,
		baseURL,
		scenario: "editing",
	});
	try {
		const state = await fixture.editing();
		await fixture.concurrent(state);
	} finally {
		await fixture.close();
	}
});

test("@history offline checkpoints survive reopen and preserve exact full and partial history", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(300_000);
	const fixture = await createSyncFixture({
		browser,
		baseURL,
		scenario: "history",
	});
	try {
		const edited = await fixture.editing();
		const checkpointed = await fixture.checkpoint(edited);
		const concurrent = await fixture.concurrent(checkpointed);
		const reopened = await fixture.reopen(concurrent);
		await fixture.partialCheckpoint(reopened);
		await fixture.history(reopened);
	} finally {
		await fixture.close();
	}
});
