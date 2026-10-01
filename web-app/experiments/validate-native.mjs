import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { openLix } from "@lix-js/sdk";
import { seedNative } from "./seed-native.mjs";

// Prove that a successful local edit does not await a slow publication ACK.
// Offline failure alone would not distinguish this from waiting for a failed
// network call. Hold actual publication requests until local work completes.
const browser = await chromium.launch();
const results = [];
try {
	for (const unrelatedFiles of [0, 5000]) {
		const fixture = await seedNative({ unrelatedFiles });
		const context = await browser.newContext();
		const page = await context.newPage();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		let blockedPushes = 0;
		await context.route("**/sync/push", async (route) => {
			blockedPushes++;
			await gate;
			await route.continue().catch(() => undefined);
		});
		try {
			const params = new URLSearchParams({
				repositoryId: fixture.repositoryId,
				branchId: fixture.branchId,
				fileId: fixture.fileId,
			});
			await page.goto(`http://127.0.0.1:8830/native.html?${params}`);
			await page.waitForFunction(
				() => window.nativePrototype?.state().ready,
				undefined,
				{ timeout: 30_000 },
			);
			const expected = `Unacknowledged native work: ${unrelatedFiles}`;
			const started = performance.now();
			await Promise.race([
				page.evaluate((text) => window.nativePrototype.edit(text), expected),
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("Local native edit waited for publication")),
						2000,
					),
				),
			]);
			const durableEditMs = performance.now() - started;
			assert.equal(
				await page.evaluate(() => window.nativePrototype.read()),
				expected,
			);
			const deadline = Date.now() + 2000;
			while (!blockedPushes && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(
				blockedPushes > 0,
				"The native publisher never reached the held network request",
			);
			assert.equal(
				await page.evaluate(() => window.nativePrototype.read()),
				expected,
			);
			// Nothing has reached the authority yet; the new value lives in native
			// pending commits, not a saved application field.
			const remote = await openLix({
				server: {
					mode: "remote",
					url: `http://127.0.0.1:18309/lix/${fixture.repositoryId}`,
					headers: {
						Authorization: "Bearer lixray-local-internal-token",
						"x-lix-account-id": "00000000-0000-4000-8000-000000000031",
						"x-lix-idempotency-scope": "prototype:account",
					},
				},
			});
			try {
				const readRemote = async () =>
					(
						await remote.execute(
							"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id=$1",
							[fixture.fileId],
						)
					).rows[0]?.content;
				assert.equal(await readRemote(), "a".repeat(1024));
				release();
				const convergenceDeadline = Date.now() + 10_000;
				while (
					Date.now() < convergenceDeadline &&
					(await readRemote()) !== expected
				)
					await new Promise((resolve) => setTimeout(resolve, 50));
				assert.equal(await readRemote(), expected);
			} finally {
				await remote.close();
			}
			results.push({
				unrelatedFiles,
				blockedPushes,
				durableEditMs,
				localReadPassedBeforeAck: true,
				authorityUnchangedBeforeRelease: true,
				convergedAfterRelease: true,
			});
		} finally {
			release();
			await page
				.evaluate(() => window.nativePrototype?.close())
				.catch(() => undefined);
			await context.close();
		}
	}
} finally {
	await browser.close();
}
const evidence = {
	scenario: "native local commit while publication is held",
	results,
	failures: 0,
};
await writeFile(
	new URL(
		"../.architecture/native-publication-validation.json",
		import.meta.url,
	),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence));
