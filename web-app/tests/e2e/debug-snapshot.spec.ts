import { expect, test } from "@playwright/test";

test("snapshot inspection is temporary and does not write browser storage", async ({
	page,
}) => {
	await page.goto("/debug");
	await expect(
		page.getByRole("heading", { name: "Open lix repository from snapshot" }),
	).toBeVisible();
	// Produce a real snapshot using the same browser SDK as the app.
	const bytes = await page.evaluate(async () => {
		const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
		const { openLix } = (await import(
			/* @vite-ignore */ sdkUrl
		)) as typeof import("@lix-js/sdk");
		const lix = await openLix();
		try {
			await lix.execute(
				"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
				[
					"/snapshot-proof.txt",
					new TextEncoder().encode("Snapshot inspection works"),
				],
			);
			return Array.from(
				new Uint8Array(await new Response(lix.exportSnapshot()).arrayBuffer()),
			);
		} finally {
			await lix.close();
		}
	});
	await page.evaluate(() => {
		Object.assign(window, { snapshotStorageWrites: [] as string[] });
		const writes = (window as unknown as { snapshotStorageWrites: string[] })
			.snapshotStorageWrites;
		Storage.prototype.setItem = function (key) {
			writes.push(key);
			throw new Error("Unexpected persistent storage write");
		};
		indexedDB.open = function () {
			writes.push("indexedDB");
			throw new Error("Unexpected IndexedDB open");
		};
		navigator.storage.getDirectory = async function () {
			writes.push("OPFS");
			throw new Error("Unexpected OPFS open");
		};
	});
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Open snapshot…" }).click();
	await (
		await chooser
	).setFiles({
		name: "repro.lixsnap",
		mimeType: "application/vnd.lix.snapshot",
		buffer: Buffer.from(bytes),
	});
	await expect(
		page.getByText("In memory · discarded on close or refresh"),
	).toBeVisible();
	await expect(
		page
			.getByRole("treeitem", { name: "snapshot-proof.txt", exact: true })
			.first(),
	).toBeVisible({ timeout: 30_000 });
	await page
		.getByRole("treeitem", { name: "snapshot-proof.txt", exact: true })
		.first()
		.dblclick();
	await expect(
		page.getByText("Snapshot inspection works", { exact: false }).first(),
	).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { snapshotStorageWrites: string[] })
					.snapshotStorageWrites,
		),
	).toEqual([]);
	await page.getByRole("button", { name: "Close snapshot", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Open lix repository from snapshot" }),
	).toBeVisible();
	await expect(page.getByLabel("Snapshot file")).toBeEnabled();
	await page.getByLabel("Snapshot file").setInputFiles({
		name: "repro.lixsnap",
		mimeType: "application/vnd.lix.snapshot",
		buffer: Buffer.from(bytes),
	});
	await expect(
		page
			.getByRole("treeitem", { name: "snapshot-proof.txt", exact: true })
			.first(),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Open lix repository from snapshot" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Close snapshot", exact: true }),
	).toHaveCount(0);
});

test("invalid snapshots show an error and allow another file", async ({
	page,
}) => {
	await page.goto("/debug");
	await expect(page.getByLabel("Snapshot file")).toBeEnabled();
	await page.getByLabel("Snapshot file").setInputFiles({
		name: "invalid.lixsnap",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("not a snapshot"),
	});
	await expect(page.getByRole("alert")).toContainText(
		"Unable to open snapshot",
	);
	await page.getByRole("button", { name: "Choose another snapshot" }).click();
	await expect(
		page.getByRole("button", { name: "Open snapshot…" }),
	).toBeVisible();
});

test("debug snapshot picker renders without client JavaScript", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	});
	try {
		const page = await context.newPage();
		const response = await page.goto("/debug");
		expect(response?.status()).toBe(200);
		await expect(
			page.getByRole("heading", { name: "Open lix repository from snapshot" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Open snapshot…" }),
		).toBeVisible();
	} finally {
		await context.close();
	}
});

test("CSV checkpoint diffs show added company-size columns from a snapshot", async ({
	page,
}) => {
	await page.goto("/debug");
	await expect(page.getByLabel("Snapshot file")).toBeEnabled();
	const bytes = await page.evaluate(async () => {
		const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
		const { openLix } = (await import(
			/* @vite-ignore */ sdkUrl
		)) as typeof import("@lix-js/sdk");
		const lix = await openLix();
		try {
			await lix.execute(
				"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
				[
					"/leads.csv",
					new TextEncoder().encode(
						"company,website\r\nExample,https://example.com\r\n",
					),
				],
			);
			await lix.execute("SELECT commit_id FROM lix_create_checkpoint()");
			await lix.execute("UPDATE lix_file SET content = $1 WHERE path = $2", [
				new TextEncoder().encode(
					"company,website,company_size_min,company_size_max\r\nExample,https://example.com,51,200\r\n",
				),
				"/leads.csv",
			]);
			await lix.execute("SELECT commit_id FROM lix_create_checkpoint()");
			return Array.from(
				new Uint8Array(await new Response(lix.exportSnapshot()).arrayBuffer()),
			);
		} finally {
			await lix.close();
		}
	});
	await page.getByLabel("Snapshot file").setInputFiles({
		name: "leads.lixsnap",
		mimeType: "application/vnd.lix.snapshot",
		buffer: Buffer.from(bytes),
	});
	await expect(
		page.getByRole("treeitem", { name: "leads.csv", exact: true }).first(),
	).toBeVisible();
	await page
		.getByRole("button", {
			name: "Latest checkpoint. Review latest checkpoint",
			exact: true,
		})
		.click();
	// Entering review preserves the current view; choose the file to inspect.
	await expect(
		page.getByRole("button", { name: "Exit", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Next changed file", exact: true })
		.click();
	const table = page.locator(".csv-review-table");
	await expect(table).toBeVisible();
	for (const name of ["company_size_min", "company_size_max"]) {
		await expect(
			table.getByRole("columnheader", { name: new RegExp(name) }),
		).toHaveAttribute("data-diff-status", "added");
	}
	await expect(
		table.getByRole("columnheader", { name: "company", exact: true }),
	).toHaveAttribute("data-diff-status", "unchanged");
	await expect(
		page.getByRole("button", { name: "Review changes", exact: true }),
	).toContainText("2 changes");
	await expect(page.locator("[data-atelier-initial-content]")).toHaveCount(0);
	// Exit restores the pre-review layout. Reopening still lets the user
	// choose the same historical file without opening its live editor.
	await page.getByRole("button", { name: "Exit", exact: true }).click();
	await expect(table).toHaveCount(0);
	await page
		.getByRole("button", {
			name: "Latest checkpoint. Review latest checkpoint",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("button", { name: "Exit", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Next changed file", exact: true })
		.click();
	await expect(table).toBeVisible();
});
