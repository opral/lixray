import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { chromium } from "@playwright/test";

// Fresh context only: exercises actual OPFS and Web Locks without opening,
// migrating, deleting, or uploading any production repository.
const bundle = await build({
	entryPoints: [
		new URL("../src/lib/repository-device-backup.ts", import.meta.url).pathname,
	],
	bundle: true,
	write: false,
	platform: "browser",
	format: "iife",
	globalName: "DeviceBackupAPI",
});
const browser = await chromium.launch();
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	await context.route("**/device-backup-validation", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Device backup validation</title>",
		}),
	);
	await page.goto("http://127.0.0.1:8830/device-backup-validation");
	await page.addScriptTag({ content: bundle.outputFiles[0].text });
	const result = await page.evaluate(async () => {
		const api = globalThis.DeviceBackupAPI;
		const name = "lixray:local-first-v1:fixture:backup-validation";
		let directory = await navigator.storage.getDirectory();
		for (const segment of [
			...api.OPFS_BACKUP_DIRECTORY,
			api.opfsBackupName(name),
		])
			directory = await directory.getDirectoryHandle(segment, { create: true });
		const nested = await directory.getDirectoryHandle(".opaque", {
			create: true,
		});
		const file = await nested.getFileHandle("pending-journal", {
			create: true,
		});
		const writer = await file.createWritable();
		await writer.write(new Uint8Array([0, 255, 81, 82, 85, 2, 3]));
		await writer.close();
		const before = [
			...new Uint8Array(await (await file.getFile()).arrayBuffer()),
		];
		let blockedFences = 0;
		for (const prefix of api.OPFS_BACKUP_LOCK_PREFIXES) {
			await navigator.locks.request(`${prefix}${name}`, async () => {
				try {
					await api.exportDeviceReplicaBackup(name);
				} catch (error) {
					if (!String(error).includes("Close other LixRay tabs")) throw error;
					blockedFences++;
				}
			});
		}
		const started = performance.now();
		const archive = [
			...new Uint8Array(
				await (await api.exportDeviceReplicaBackup(name)).arrayBuffer(),
			),
		];
		const after = [
			...new Uint8Array(await (await file.getFile()).arrayBuffer()),
		];
		return {
			before,
			after,
			blockedFences,
			archive,
			durationMs: performance.now() - started,
		};
	});
	assert.equal(result.blockedFences, 2);
	assert.deepEqual(result.before, result.after);
	const archive = unzipSync(new Uint8Array(result.archive));
	assert.deepEqual([...archive["opfs/.opaque/pending-journal"]], result.before);
	const evidence = {
		passed: true,
		actualOpfs: true,
		blockedFences: result.blockedFences,
		sourceBytesUnchanged: true,
		archivedBytesExact: true,
		archiveBytes: result.archive.length,
		durationMs: result.durationMs,
	};
	await writeFile(
		process.env.DEVICE_BACKUP_EVIDENCE ??
			"../docs/experiments/device-backup-validation.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(JSON.stringify(evidence));
	await context.close();
} finally {
	await browser.close();
}
