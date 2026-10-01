import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { openLix } from "@lix-js/sdk";
import { seedArchitecture } from "./seed-architecture.mjs";

const previewOrigin =
	process.env.PROTOTYPE_PREVIEW_ORIGIN ?? "http://127.0.0.1:8830";
const lixOrigin = process.env.PROTOTYPE_LIX_ORIGIN ?? "http://127.0.0.1:18309";
const accountId = "00000000-0000-4000-8000-000000000031";
const browserTimeoutMs = 30_000;
const results = [];
const failures = [];
const browser = await chromium.launch();

function fixtureUrl(fixture) {
	const params = new URLSearchParams({
		repositoryId: fixture.repositoryId,
		branchId: fixture.branchId,
		fileId: fixture.fileId,
		mode: "working-set",
	});
	return `${previewOrigin}/architecture.html?${params}`;
}

async function seedFixture() {
	return seedArchitecture({ bytes: 1024, unrelatedFiles: 0 });
}

async function openPage(context, fixture) {
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(fixtureUrl(fixture), {
		waitUntil: "load",
		timeout: browserTimeoutMs,
	});
	await waitUntilReady(page);
	return { page, pageErrors };
}

async function waitUntilReady(page) {
	await page.waitForFunction(
		() => {
			const status = document.querySelector("#status")?.textContent ?? "";
			return (
				status === "working-set: ready" ||
				status.includes("open_to_usable: error")
			);
		},
		null,
		{ timeout: browserTimeoutMs },
	);
	const status = await page.locator("#status").textContent();
	assert.equal(
		status,
		"working-set: ready",
		`Prototype failed to open: ${status}`,
	);
}

async function readPage(page) {
	return page.evaluate(() => window.__architecture.read());
}

async function readView(page) {
	return page.evaluate(() => window.__architecture.pending());
}

async function metrics(page) {
	return page.evaluate(() => window.__architecture.metrics());
}

async function assertNoRemoteRequests(page, message) {
	const measured = await metrics(page);
	assert.equal(measured.attempts.length, 0, message);
	assert.equal(
		measured.network.length,
		0,
		`${message} (network response records)`,
	);
}

async function blockLixRequests(page) {
	const blocked = [];
	await page.route("**/lix/**", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		blocked.push(route.request().url());
		await route.abort("internetdisconnected");
	});
	return blocked;
}

async function withPage(fixture, run) {
	const context = await browser.newContext();
	let page;
	let pageErrors;
	try {
		({ page, pageErrors } = await openPage(context, fixture));
		return await run({ context, page, pageErrors });
	} finally {
		if (page)
			await page
				.evaluate(() => window.__architecture?.close())
				.catch(() => undefined);
		await context.close();
	}
}

async function withNativeAuthority(fixture, run) {
	const headers = {
		Authorization: "Bearer lixray-local-internal-token",
		"x-lix-account-id": accountId,
		"x-lix-idempotency-scope": "prototype:account",
	};
	const lix = await openLix({
		server: {
			mode: "remote",
			url: `${lixOrigin}/lix/${fixture.repositoryId}`,
			headers,
		},
	});
	try {
		if ((await lix.activeBranchId()) !== fixture.branchId) {
			await lix.switchBranch({ branchId: fixture.branchId });
		}
		assert.equal(await lix.activeBranchId(), fixture.branchId);
		return await run(lix);
	} finally {
		await lix.close();
	}
}

async function readAuthority(lix, fixture) {
	const result = await lix.execute(
		"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
		[fixture.fileId],
	);
	const content = result.rows[0]?.content;
	assert.equal(
		typeof content,
		"string",
		"The fixture file must exist on the authority.",
	);
	return content;
}

async function writeAuthority(lix, fixture, content) {
	const result = await lix.execute(
		"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2 RETURNING id",
		[content, fixture.fileId],
		{ idempotencyKey: randomUUID() },
	);
	assert.equal(
		result.rows.length,
		1,
		"The independent authority edit must update the fixture file.",
	);
}

async function historyCount(lix, fixture) {
	const head = await lix.execute(
		"SELECT lix_active_branch_commit_id() AS commit_id",
		[],
	);
	const commitId = head.rows[0]?.commit_id;
	assert.equal(typeof commitId, "string");
	const history = await lix.execute(
		"SELECT lixcol_position FROM lix_history('lix_file', $1) WHERE id = $2",
		[commitId, fixture.fileId],
	);
	return history.rows.length;
}

async function scenario(name, action) {
	try {
		const result = await action();
		results.push({ name, status: "passed", ...result });
		console.log(
			JSON.stringify({ scenario: name, status: "passed", ...result }),
		);
	} catch (error) {
		const failure = { name, status: "failed", error: String(error) };
		failures.push(failure);
		console.error(JSON.stringify(failure));
	}
}

await scenario(
	"clean IndexedDB state survives online page reload",
	async () => {
		const fixture = await seedFixture();
		return withPage(fixture, async ({ page, pageErrors }) => {
			const initial = await readPage(page);
			assert.equal(initial, "a".repeat(fixture.bytes));
			await page.reload({ waitUntil: "load", timeout: browserTimeoutMs });
			await waitUntilReady(page);
			assert.equal(await readPage(page), initial);
			await assertNoRemoteRequests(
				page,
				"Clean warm reopen should read IndexedDB only.",
			);
			assert.deepEqual(pageErrors, []);
			return {
				repositoryId: fixture.repositoryId,
				reloadContentBytes: initial.length,
			};
		});
	},
);

await scenario(
	"pending IndexedDB edit survives reload and cache reset",
	async () => {
		const fixture = await seedFixture();
		return withPage(fixture, async ({ page, pageErrors }) => {
			const initial = await readPage(page);
			const edited = `${initial}\nlocal edit before reload`;
			await page.evaluate(
				(content) => window.__architecture.edit(content),
				edited,
			);
			const beforeReset = await readView(page);
			const operationId = beforeReset.pending[0]?.operationId;
			assert.ok(operationId);
			assert.equal(beforeReset.pending[0]?.baseContent, initial);

			const blockedLixRequests = await blockLixRequests(page);
			await page.reload({ waitUntil: "load", timeout: browserTimeoutMs });
			await waitUntilReady(page);
			assert.equal(await readPage(page), edited);
			assert.equal((await readView(page)).pending[0]?.operationId, operationId);
			await assertNoRemoteRequests(
				page,
				"Pending warm reopen should not read the server.",
			);

			await page.evaluate(() => window.__architecture.resetCache());
			await page.reload({ waitUntil: "load", timeout: browserTimeoutMs });
			await waitUntilReady(page);
			const afterReset = await readView(page);
			assert.equal(afterReset.content, edited);
			assert.equal(afterReset.pending[0]?.operationId, operationId);
			assert.equal(afterReset.pending[0]?.baseContent, initial);
			await assertNoRemoteRequests(
				page,
				"Outbox-only reopen after cache reset must not read the server.",
			);
			assert.deepEqual(
				blockedLixRequests,
				[],
				"A pending outbox must reopen even with Lix requests blocked.",
			);
			await page.unroute("**/lix/**");
			assert.deepEqual(pageErrors, []);
			return {
				repositoryId: fixture.repositoryId,
				operationId,
				pendingBytes: edited.length,
			};
		});
	},
);

await scenario(
	"lost publish acknowledgement retries one authority commit",
	async () => {
		const fixture = await seedFixture();
		return withNativeAuthority(fixture, async (nativeLix) => {
			const historyBefore = await historyCount(nativeLix, fixture);
			return withPage(fixture, async ({ page, pageErrors }) => {
				const initial = await readPage(page);
				const edited = `${initial}\nacknowledgement retry`;
				await page.evaluate(
					(content) => window.__architecture.edit(content),
					edited,
				);
				const operationId = (await readView(page)).pending[0]?.operationId;
				assert.ok(operationId);

				const requestHeaders = [];
				const headerReads = [];
				page.on("request", (request) => {
					if (
						request.method() !== "POST" ||
						!new URL(request.url()).pathname.endsWith("/execute")
					) {
						return;
					}
					headerReads.push(
						request.allHeaders().then((headers) => {
							requestHeaders.push(headers["idempotency-key"] ?? "");
						}),
					);
				});

				await page.evaluate(() => window.__architecture.dropNextAck());
				const firstSync = await page.evaluate(() =>
					window.__architecture.sync(),
				);
				if (firstSync.status === "offline") {
					assert.equal(
						(await readView(page)).pending[0]?.operationId,
						operationId,
					);
					assert.equal(
						(await page.evaluate(() => window.__architecture.sync())).status,
						"synced",
					);
				} else {
					assert.equal(
						firstSync.status,
						"synced",
						"The Lix adapter may recover the receipt internally.",
					);
				}
				await Promise.all(headerReads);
				const operationRequests = requestHeaders.filter(
					(header) => header === operationId,
				);
				assert.ok(
					operationRequests.length >= 2,
					`The dropped acknowledgement must replay the same operation (observed ${operationRequests.length} requests with operation id ${operationId}).`,
				);
				assert.ok(operationRequests.every((header) => header === operationId));

				const authorityContent = await readAuthority(nativeLix, fixture);
				assert.equal(authorityContent, edited);
				assert.equal(await historyCount(nativeLix, fixture), historyBefore + 1);
				assert.deepEqual(pageErrors, []);
				return {
					repositoryId: fixture.repositoryId,
					operationId,
					mutationAttempts: operationRequests.length,
					authorityHistoryDelta:
						(await historyCount(nativeLix, fixture)) - historyBefore,
				};
			});
		});
	},
);

await scenario(
	"server conflict preserves local text until explicit resolution",
	async () => {
		const fixture = await seedFixture();
		return withNativeAuthority(fixture, async (nativeLix) => {
			return withPage(fixture, async ({ page, pageErrors }) => {
				const initial = await readPage(page);
				const localEdit = `${initial}\nlocal tab edit`;
				const serverEdit = `${initial}\nindependent server edit`;
				await page.evaluate(
					(content) => window.__architecture.edit(content),
					localEdit,
				);
				await writeAuthority(nativeLix, fixture, serverEdit);

				const conflictResult = await page.evaluate(() =>
					window.__architecture.sync(),
				);
				assert.equal(conflictResult.status, "conflict");
				const view = await readView(page);
				assert.equal(view.status, "conflict");
				assert.equal(view.content, localEdit);
				assert.equal(view.conflict?.localContent, localEdit);
				assert.equal(view.conflict?.actual.content, serverEdit);

				const merged = `${serverEdit}\nresolved local edit`;
				await page.evaluate(
					(content) => window.__architecture.resolveConflict(content),
					merged,
				);
				assert.equal(
					(await page.evaluate(() => window.__architecture.sync())).status,
					"synced",
				);
				assert.equal(await readAuthority(nativeLix, fixture), merged);
				assert.equal((await readView(page)).status, "clean");
				assert.deepEqual(pageErrors, []);
				return {
					repositoryId: fixture.repositoryId,
					localEditBytes: localEdit.length,
					mergedBytes: merged.length,
				};
			});
		});
	},
);

await scenario(
	"shared IndexedDB rejects stale edits from a second tab",
	async () => {
		const fixture = await seedFixture();
		const context = await browser.newContext();
		let firstPage;
		let secondPage;
		try {
			({ page: firstPage } = await openPage(context, fixture));
			const initial = await readPage(firstPage);
			({ page: secondPage } = await openPage(context, fixture));
			const firstEdit = `${initial}\nfirst tab edit`;
			await firstPage.evaluate(
				(content) => window.__architecture.edit(content),
				firstEdit,
			);
			await assertNoRemoteRequests(
				secondPage,
				"Second tab should load the shared local cache without a network read.",
			);

			await assert.rejects(
				secondPage.evaluate(
					(content) => window.__architecture.edit(content),
					`${initial}\nstale second tab`,
				),
				/stale/i,
			);
			assert.equal(await readPage(secondPage), firstEdit);
			assert.equal((await readView(firstPage)).pending.length, 1);
			assert.equal((await readView(firstPage)).content, firstEdit);
			return {
				repositoryId: fixture.repositoryId,
				sharedPendingBytes: firstEdit.length,
			};
		} finally {
			if (secondPage)
				await secondPage
					.evaluate(() => window.__architecture?.close())
					.catch(() => undefined);
			if (firstPage)
				await firstPage
					.evaluate(() => window.__architecture?.close())
					.catch(() => undefined);
			await context.close();
		}
	},
);

try {
	const preview = await fetch(`${previewOrigin}/architecture.html`, {
		signal: AbortSignal.timeout(5_000),
	});
	assert.equal(
		preview.status,
		200,
		`Expected the built prototype preview at ${previewOrigin}`,
	);
} catch (error) {
	failures.push({
		name: "preview availability",
		status: "failed",
		error: String(error),
	});
} finally {
	await browser.close();
	await mkdir(".architecture", { recursive: true });
	await writeFile(
		".architecture/validation.json",
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				previewOrigin,
				lixOrigin,
				results,
				failures,
				notes: [
					"Runs against the built loopback preview and the local native Lix server using fresh synthetic repositories.",
					"Reload validation exercises actual browser IndexedDB persistence; it does not claim browser-process crash or profile-eviction survival.",
					"Account and branch key separation are covered by the module unit tests; this script exercises file edit/reopen/sync behavior in the native fixture.",
					"Credentials are the loopback prototype seed credentials and do not represent production authentication.",
				],
			},
			null,
			2,
		),
	);
}

console.log(
	JSON.stringify({
		validation: failures.length === 0 ? "passed" : "failed",
		passed: results.length,
		failed: failures.length,
		artifact: ".architecture/validation.json",
	}),
);
process.exitCode = failures.length === 0 ? 0 : 1;
