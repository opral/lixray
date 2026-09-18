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
	let primaryFailure: unknown;
	try {
		const state = await fixture.editing();
		await fixture.concurrent(state);
		await fixture.continuousIndependentEdits(state);
	} catch (error) {
		primaryFailure = error;
		throw error;
	} finally {
		await fixture.close(primaryFailure);
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
	let primaryFailure: unknown;
	try {
		const edited = await fixture.editing();
		const checkpointed = await fixture.checkpoint(edited);
		const concurrent = await fixture.concurrent(checkpointed);
		const reopened = await fixture.reopen(concurrent);
		await fixture.partialCheckpoint(reopened);
		await fixture.history(reopened);
	} catch (error) {
		primaryFailure = error;
		throw error;
	} finally {
		await fixture.close(primaryFailure);
	}
});

test("@conflicts independent replicas converge after both orders of same-row offline edits", async ({
	browser,
	baseURL,
}) => {
	test.skip(
		process.env.PLAYWRIGHT_SYNC_LOCAL !== "1",
		"conflict injection requires disposable local repositories",
	);
	test.setTimeout(300_000);
	const fixture = await createSyncFixture({
		browser,
		baseURL,
		scenario: "conflicts",
	});
	let primaryFailure = false;
	try {
		await fixture.independentConflicts(await fixture.editing());
	} catch (error) {
		primaryFailure = true;
		throw error;
	} finally {
		await fixture.close().catch((error: unknown) => {
			if (!primaryFailure) throw error;
			test.info().annotations.push({
				type: "cleanup-error",
				description: String(error),
			});
		});
	}
});
