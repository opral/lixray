import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Opt-in integration test against a running full demo app and real Lix server:
// LIXRAY_DIRECTORY_QA=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:8787 \
//   pnpm exec playwright test tests/e2e/directory-drag.spec.ts
test.skip(
	process.env.LIXRAY_DIRECTORY_QA !== "1",
	"Requires the full demo preview",
);

const repositoryPath =
	process.env.LIXRAY_DIRECTORY_QA_PATH ?? "/@acme/launch-q3";
const serverUrl =
	process.env.LIXRAY_DIRECTORY_QA_SERVER_URL ??
	"http://127.0.0.1:38493/lix/00000000-0000-4000-8000-000000000002";
const serverToken =
	process.env.LIXRAY_DIRECTORY_QA_TOKEN ?? "lixray-local-internal-token";

function row(page: Page, name: string) {
	return page
		.getByRole("grid", { name: "Files and folders", exact: true })
		.getByRole("row")
		.filter({ has: page.getByText(name, { exact: true }) });
}

async function expectShell(page: Page) {
	await expect(page.locator("[data-app-titlebar]")).toBeVisible();
	await expect(
		page.getByText("Unable to render Atelier", { exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("grid", { name: "Files and folders", exact: true }),
	).toBeVisible();
}

for (const count of [1, 2]) {
	test(`full app drags ${count === 1 ? "a folder" : "two selected folders"} offline with descendants and syncs after reconnect`, async ({
		page,
	}, testInfo) => {
		// Import only inside the opted-in test so normal app E2E discovery does
		// not require a native SDK binary or contact this local demo server.
		const { openLix } = await import("@lix-js/sdk");
		const lix = await openLix({
			server: {
				mode: "remote",
				url: serverUrl,
				headers: { authorization: `Bearer ${serverToken}` },
			},
		});
		const prefix = `qa-drag-${randomUUID()}`;
		const targetName = `${prefix}-target`;
		const targetPath = `/${targetName}`;
		const directoryIds: string[] = [];
		const fileIds: string[] = [];
		const sources: { name: string; fileId: string; bytes: number[] }[] = [];
		const browserErrors: string[] = [];
		page.on("pageerror", (error) => browserErrors.push(error.message));

		async function createDirectory(path: string) {
			const created = await lix.execute(
				"INSERT INTO lix_directory (path) VALUES ($1) RETURNING id",
				[path],
			);
			directoryIds.push(String(created.rows[0]!.id));
		}

		try {
			await createDirectory(targetPath);
			for (let index = 0; index < count; index++) {
				const name = `${prefix}-source-${index + 1}`;
				await createDirectory(`/${name}`);
				await createDirectory(`/${name}/nested`);
				await createDirectory(`/${name}/nested/empty`);
				const content = new TextEncoder().encode(
					`Keep these bytes: ${prefix}, source ${index + 1}, café.\n`,
				);
				const created = await lix.execute(
					"INSERT INTO lix_file (path, content) VALUES ($1, $2) RETURNING id",
					[`/${name}/nested/note.txt`, content],
				);
				const fileId = String(created.rows[0]!.id);
				fileIds.push(fileId);
				sources.push({ name, fileId, bytes: Array.from(content) });
			}

			await page.goto(repositoryPath);
			await expectShell(page);
			for (const source of sources)
				await expect(row(page, source.name)).toBeVisible();
			await expect(row(page, targetName)).toBeVisible();
			if (count > 1) {
				for (const source of sources) {
					await row(page, source.name).hover();
					await row(page, source.name).locator("label").click();
				}
				await expect(page.getByRole("row", { selected: true })).toHaveCount(
					count,
				);
			}
			// Block only the protocol so app assets remain available for reload.
			// A successful drag must commit through OPFS without server writes.
			await page.context().route("**/lix/**", (route) => route.abort());
			await row(page, sources[0]!.name).dragTo(row(page, targetName));
			for (const source of sources)
				await expect(row(page, source.name)).toHaveCount(0);
			await expectShell(page);
			await expect(
				page.getByRole("toolbar", { name: "Selection actions" }),
			).toHaveCount(0);

			await row(page, targetName).click();
			await expect(page).toHaveURL(
				new RegExp(`/dir/${targetName}/?(?:\\?.*)?$`),
			);
			for (const source of sources)
				await expect(row(page, source.name)).toBeVisible();
			await row(page, sources[0]!.name).click();
			await row(page, "nested").click();
			await expect(row(page, "empty")).toBeVisible();
			await expect(row(page, "note.txt")).toBeVisible();
			await page.reload();
			await expectShell(page);
			await expect(row(page, "empty")).toBeVisible();
			await expect(row(page, "note.txt")).toBeVisible();

			await page.context().unroute("**/lix/**");
			for (const source of sources) {
				await expect
					.poll(
						async () => {
							const result = await lix.execute(
								"SELECT path FROM lix_file WHERE id = $1",
								[source.fileId],
							);
							return result.rows[0]?.path;
						},
						{ timeout: 30_000 },
					)
					.toBe(`${targetPath}/${source.name}/nested/note.txt`);
				const persisted = await lix.execute(
					"SELECT path, content FROM lix_file WHERE id = $1",
					[source.fileId],
				);
				expect(persisted.rows).toHaveLength(1);
				expect(persisted.rows[0]!.path).toBe(
					`${targetPath}/${source.name}/nested/note.txt`,
				);
				expect(Array.from(persisted.rows[0]!.content as Uint8Array)).toEqual(
					source.bytes,
				);
				const empty = await lix.execute(
					"SELECT path FROM lix_directory WHERE path = $1",
					[`${targetPath}/${source.name}/nested/empty`],
				);
				expect(empty.rows).toHaveLength(1);
			}
			const screenshot = testInfo.outputPath(`folder-drop-${count}.png`);
			await page.screenshot({ path: screenshot, fullPage: true });
			await testInfo.attach("Moved folder after reload", {
				path: screenshot,
				contentType: "image/png",
			});
			expect(
				browserErrors,
				"No full-app runtime errors during moves or reload",
			).toEqual([]);
		} finally {
			await page.context().unroute("**/lix/**");
			try {
				// IDs come exclusively from this test's inserts, so cleanup follows
				// moved entries without a broad prefix match against repository data.
				for (const id of fileIds)
					await lix.execute("DELETE FROM lix_file WHERE id = $1", [id]);
				for (const id of directoryIds.reverse())
					await lix.execute("DELETE FROM lix_directory WHERE id = $1", [id]);
			} finally {
				await lix.close();
			}
		}
	});
}
