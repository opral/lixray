import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import {
	exportDeviceReplicaBackup,
	inspectDeviceStorage,
	opfsBackupName,
	OPFS_BACKUP_LOCK_PREFIXES,
	type DeviceBackupEnvironment,
} from "./repository-device-backup.ts";

const storageName =
	"lixray:local-first-v1:repo:account:device:replacement:saved";

void test("physical backup uses the pinned provider directory and both ownership fences", async () => {
	const source = await readFile(
		new URL(
			"../../../vendor/lix/packages/storage-opfs/js/provider.ts",
			import.meta.url,
		),
		"utf8",
	);
	assert.match(source, /SQLITE_VFS_DIRECTORY = "\/lix\/sqlite-sahpool"/u);
	for (const prefix of OPFS_BACKUP_LOCK_PREFIXES)
		assert.ok(source.includes(`"${prefix}"`));
	assert.equal(
		opfsBackupName("a/é+"),
		Buffer.from("a/é+").toString("base64url"),
	);
});

void test("codec-independent backup retains exact opaque bytes while holding both fences", async () => {
	const held: string[] = [];
	const paths: string[] = [];
	const bytes = new Uint8Array([0, 255, 1, 85, 24, 25]);
	const directory = {
		getDirectoryHandle: async (name: string) => {
			paths.push(name);
			return directory;
		},
		async *values() {
			assert.deepEqual(
				held,
				OPFS_BACKUP_LOCK_PREFIXES.map((prefix) => `${prefix}${storageName}`),
			);
			yield {
				kind: "file",
				name: "opaque-journal",
				getFile: async () => new Blob([bytes]),
			};
		},
	};
	const environment = {
		locks: {
			request: async (
				name: string,
				options: unknown,
				callback: (lock: object) => Promise<Blob>,
			) => {
				assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
				held.push(name);
				try {
					return await callback({});
				} finally {
					held.pop();
				}
			},
		},
		getDirectory: async () => directory,
	} as unknown as DeviceBackupEnvironment;
	const archive = unzipSync(
		new Uint8Array(
			await (
				await exportDeviceReplicaBackup(storageName, environment)
			).arrayBuffer(),
		),
	);
	assert.deepEqual(archive["opfs/opaque-journal"], bytes);
	assert.deepEqual(paths, [
		"lix",
		"sqlite-sahpool",
		opfsBackupName(storageName),
	]);
	assert.equal(
		(
			JSON.parse(strFromU8(archive["manifest.json"]!)) as {
				storageName: string;
			}
		).storageName,
		storageName,
	);
	assert.deepEqual(held, []);
});

void test("a live old owner prevents backup before any file access", async () => {
	let accessed = false;
	const environment = {
		locks: {
			request: async (
				_name: string,
				_options: unknown,
				callback: (lock: null) => Promise<Blob>,
			) => callback(null),
		},
		getDirectory: async () => {
			accessed = true;
			throw new Error("must not read");
		},
	} as unknown as DeviceBackupEnvironment;
	await assert.rejects(
		exportDeviceReplicaBackup(storageName, environment),
		/Close other LixRay tabs/u,
	);
	assert.equal(accessed, false);
});

void test("oversized raw stores stop before reading payload bytes and release both fences", async () => {
	const held: string[] = [];
	let payloadRead = false;
	const directory = {
		getDirectoryHandle: async () => directory,
		async *values() {
			yield {
				kind: "file",
				name: "large-database",
				getFile: async () =>
					({
						size: 256 * 1024 * 1024 + 1,
						arrayBuffer: async () => {
							payloadRead = true;
							throw new Error("payload must stay unread");
						},
					}) as unknown as Blob,
			};
		},
	};
	const environment = {
		locks: {
			request: async (
				name: string,
				_options: unknown,
				callback: (lock: object) => Promise<Blob>,
			) => {
				held.push(name);
				try {
					return await callback({});
				} finally {
					held.pop();
				}
			},
		},
		getDirectory: async () => directory,
	} as unknown as DeviceBackupEnvironment;
	await assert.rejects(
		exportDeviceReplicaBackup(storageName, environment),
		/browser download limit/u,
	);
	assert.equal(payloadRead, false);
	assert.deepEqual(held, []);
});

void test("quota pressure and denied persistence are visible without rejecting native open", async () => {
	assert.deepEqual(
		await inspectDeviceStorage({
			persisted: async () => false,
			estimate: async () => ({ usage: 80, quota: 100 }),
		}),
		{ persistent: false, pressure: true },
	);
	assert.deepEqual(
		await inspectDeviceStorage({
			persisted: async () => {
				throw new Error("denied");
			},
			estimate: async () => {
				throw new Error("unavailable");
			},
		}),
		{ persistent: null, pressure: false },
	);
	assert.deepEqual(
		await inspectDeviceStorage({
			persisted: async () => true,
			estimate: async () => ({ usage: Infinity, quota: 0 }),
		}),
		{ persistent: true, pressure: false },
	);
});
