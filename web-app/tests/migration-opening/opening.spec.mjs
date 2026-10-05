import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("existing OPFS replica opens through the app, preserves edits, and survives reload and another tab", async ({
	context,
	page,
}) => {
	await page.goto("/?seed=1");
	await page.waitForFunction(() => Boolean(window.migrationQa));
	const seeded = await page.evaluate(() => window.migrationQa.seed());
	expect(seeded.entries).toBeGreaterThan(0);
	// Closing the old writer page releases its physical OPFS owner. The new app
	// must locate that file using the same durable browser identity.
	await page.close();
	const first = await context.newPage();
	const path = [
		"synthetic-sparse-v77-full-sync",
		"synthetic-v82-v2-partial-replica",
		"synthetic-current-v3-partial-replica",
	].includes(seeded.fixtureKind)
		? "/?slowLegacy=1"
		: "/";
	await first.goto(path);
	await first.waitForFunction(() => Boolean(window.migrationQa));
	// Do not wrap this in test-side retries: the real app must resume transient
	// opening/conversion failures itself, including lost committed merge replies.
	const opened = await first.evaluate(() => window.migrationQa.open());
	expect(opened.name).toBe(seeded.name);
	await assertValues(first);
	if (path.includes("slowLegacy"))
		expect(
			await first.evaluate(() => window.migrationQa.delays()),
		).toBeGreaterThan(0);
	const second = await context.newPage();
	await second.goto(path);
	await second.waitForFunction(() => Boolean(window.migrationQa));
	expect((await second.evaluate(() => window.migrationQa.open())).name).toBe(
		seeded.name,
	);
	await assertValues(second);
	await second.close();
	await first.reload();
	await first.waitForFunction(() => Boolean(window.migrationQa));
	expect((await first.evaluate(() => window.migrationQa.open())).name).toBe(
		seeded.name,
	);
	await assertValues(first);
});

async function assertValues(page) {
	const result = await page.evaluate(() => window.migrationQa.values());
	if (result.kind === "legacy") {
		expect(result.rows).toEqual([{ key: "upgrade-test", value: "preserved" }]);
		expect(result.files).toEqual([
			{ path: "/legacy-small.bin", length: 3, matches: true },
			{ path: "/legacy-large.bin", length: 300 * 1024, matches: true },
		]);
		expect(result.custom).toEqual([
			{ id: "legacy", value: "custom-preserved" },
		]);
		if (result.pending) {
			expect(result.sources.some((source) => source.recoveryRequired)).toBe(
				true,
			);
			expect(result.retained).toContainEqual({
				snapshot: { key: "offline-recovery", value: "saved" },
				untracked: false,
			});
			expect(result.retained).toContainEqual({
				snapshot: { key: "local-only-upgrade-test", value: "local-only" },
				untracked: true,
			});
		}
	} else if (["v2-partial", "v3-partial"].includes(result.kind)) {
		expect(result.rows).toEqual([result.pendingRow]);
	} else {
		expect(result.main).toEqual([
			{ key: "local", value: "L" },
			{ key: "remote", value: "R" },
		]);
		expect(result.other).toEqual([
			{ key: "local", value: "XL" },
			{ key: "remote", value: "XR" },
		]);
		expect(result.custom).toEqual([{ value: "after" }]);
		expect(result.files).toEqual([
			{ path: "/local.bin", content: [8, 9, 10] },
			{ path: "/remote.bin", content: [5, 6, 7] },
		]);
	}
}

for (const scenario of [
	"second tab during migration",
	"tab closed during migration",
]) {
	test(scenario, async ({ context, page }) => {
		await page.goto("/");
		await page.waitForFunction(() => Boolean(window.migrationQa));
		const seeded = await page.evaluate(() => window.migrationQa.seed());
		test.skip(
			![
				"synthetic-sparse-v77-full-sync",
				"synthetic-v82-v2-partial-replica",
				"synthetic-current-v3-partial-replica",
			].includes(seeded.fixtureKind),
			"Requires a migration receipt pause",
		);
		await page.close();
		const first = await context.newPage();
		await first.goto("/?slowLegacy=1");
		await first.waitForFunction(() => Boolean(window.migrationQa));
		await first.evaluate(() => {
			window.pendingMigrationOpen = window.migrationQa.open().then(
				(result) => ({ ok: true, ...result }),
				(error) => ({ ok: false, message: error.message, code: error.code }),
			);
		});
		await first.waitForFunction(() => window.migrationQa.delays() > 0);
		if (scenario === "tab closed during migration") await first.close();
		const second = await context.newPage();
		await second.goto("/?slowLegacy=1");
		await second.waitForFunction(() => Boolean(window.migrationQa));
		expect((await second.evaluate(() => window.migrationQa.open())).name).toBe(
			seeded.name,
		);
		await assertValues(second);
		if (!first.isClosed()) {
			expect(
				await first.evaluate(() => window.pendingMigrationOpen),
			).toMatchObject({ ok: true, name: seeded.name });
			await assertValues(first);
			await first.close();
		}
		await second.reload();
		await second.waitForFunction(() => Boolean(window.migrationQa));
		expect((await second.evaluate(() => window.migrationQa.open())).name).toBe(
			seeded.name,
		);
		await assertValues(second);
	});
}

test("saved legacy device changes can be downloaded without changing the open repository", async ({
	context,
	page,
}) => {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.migrationQa));
	const seeded = await page.evaluate(() => window.migrationQa.seed());
	test.skip(
		seeded.fixtureKind !== "synthetic-sparse-v77-full-sync",
		"Requires legacy recovery data",
	);
	await page.close();
	const current = await context.newPage();
	await current.goto("/");
	await current.waitForFunction(() => Boolean(window.migrationQa));
	const opened = await current.evaluate(() => window.migrationQa.open());
	const initial = await current.evaluate(() => window.migrationQa.values());
	test.skip(!initial.pending, "Requires LIX_BROWSER_LEGACY_PENDING=1");
	await current.evaluate(() => window.migrationQa.mountRecovery());
	await expect(
		current.getByRole("button", { name: "Download recovery data" }),
	).toBeVisible();
	await expect(
		current.getByRole("button", { name: "Restore to recovery branches" }),
	).toHaveCount(0);
	const downloading = current.waitForEvent("download");
	await current.getByRole("button", { name: "Download recovery data" }).click();
	const download = await downloading;
	const bundle = JSON.parse(await readFile(await download.path(), "utf8"));
	const retained = bundle.branches
		.flatMap((branch) => branch.rows)
		.filter((row) =>
			["offline-recovery", "local-only-upgrade-test"].includes(
				row.snapshot?.key,
			),
		)
		.map((row) => ({ snapshot: row.snapshot, untracked: row.untracked }));
	expect(retained).toEqual(initial.retained);
	expect(await current.evaluate(() => window.migrationQa.values())).toEqual(
		initial,
	);
	await current.reload();
	await current.waitForFunction(() => Boolean(window.migrationQa));
	expect(await current.evaluate(() => window.migrationQa.open())).toEqual(
		opened,
	);
	expect(await current.evaluate(() => window.migrationQa.values())).toEqual(
		initial,
	);
});

test("durable admission supports offline reopen after owner closes", async ({
	context,
	page,
}) => {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.migrationQa));
	const seeded = await page.evaluate(() => window.migrationQa.seed());
	await page.close();
	const online = await context.newPage();
	await online.goto("/");
	await online.waitForFunction(() => Boolean(window.migrationQa));
	await online.evaluate(() => window.migrationQa.open());
	await assertValues(online);
	await online.close();
	// Load the new document's modules online, then make every repository transport
	// call fail. The prior owner and its memory-only admission cache are gone.
	const offline = await context.newPage();
	await offline.goto("/");
	await offline.waitForFunction(() => Boolean(window.migrationQa));
	// Fail actual repository fetches at the browser network boundary. Keep assets
	// available and navigator online, as when only the service is unreachable.
	await context.route("**/lix/v1/**", (route) =>
		route.abort("internetdisconnected"),
	);
	expect(await offline.evaluate(() => navigator.onLine)).toBe(true);
	expect((await offline.evaluate(() => window.migrationQa.open())).name).toBe(
		seeded.name,
	);
	await assertValues(offline);
});
