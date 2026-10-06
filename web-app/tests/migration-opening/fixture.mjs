import { networkFetch } from "@lix-js/sdk";
/* global __OLD_OPFS_MODULE__ */
import { openRepositoryLixSession } from "../../src/lib/repository-lix-session.ts";
import {
	repositoryBrowserReplicaId,
	repositoryOpfsCacheName,
} from "../../src/lib/repository-opfs-cache.ts";
const fixture = await (await fetch("/__fixture.json")).json();
let session;
let delays = 0;
new BroadcastChannel("lixray-migration-qa-delay").onmessage = () => {
	delays++;
};
const scope = {
	authIdentity: "synthetic-migration-qa",
	repositoryId: fixture.repositoryId,
};
async function identity() {
	return repositoryOpfsCacheName({
		repositoryId: scope.repositoryId,
		replicaId: await repositoryBrowserReplicaId(scope),
	});
}
async function seed() {
	const name = await identity();
	const { OpfsStorage } = await import(/* @vite-ignore */ __OLD_OPFS_MODULE__);
	const registration = new OpfsStorage({ name }).lixStorage;
	const provider = await (
		await import(/* @vite-ignore */ registration.moduleUrl)
	).createLixStorageProvider(registration.options);
	try {
		const sessionToken = await provider.acquireSession();
		const write = await provider.beginWrite({
			awaitDurable: true,
			sessionToken,
			preconditions: [],
			batchCapacityHintBytes: 0,
		});
		for (const entry of fixture.entries)
			await write.putMany(
				{
					id: entry.space,
					name: `fixture-${entry.space}`,
					valueSemantics: "mutable",
					valueIntegrity: "backendVerified",
				},
				[
					{
						key: new Uint8Array(entry.key),
						value: new Uint8Array(entry.value),
					},
				],
			);
		await write.commit();
		return {
			name,
			entries: fixture.entries.length,
			fixtureKind: fixture.fixtureKind ?? "pending-full-replica",
		};
	} finally {
		await provider.close();
	}
}
async function proxyFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const body = ["GET", "HEAD"].includes(request.method)
		? undefined
		: await request.arrayBuffer();
	return networkFetch(url.pathname + url.search, {
		method: request.method,
		headers: request.headers,
		body,
		signal: request.signal,
	});
}
async function open() {
	session = await openRepositoryLixSession({
		...scope,
		namespace: "synthetic",
		repositorySlug: "migration",
		getAccessToken: async () => null,
		allowAnonymous: true,
		origin: new URL(fixture.url).origin,
		fetch: proxyFetch,
	});
	return {
		name: await identity(),
		activeBranch: session.activeBranchSnapshot(),
		defaultBranch: session.defaultBranchSnapshot(),
	};
}
async function values() {
	if (
		[
			"synthetic-v82-v2-partial-replica",
			"synthetic-current-v3-partial-replica",
		].includes(fixture.fixtureKind)
	) {
		const rows = (
			await session.lix.execute(
				"SELECT key,value FROM lix_key_value WHERE key=$1",
				[fixture.pendingRow.key],
			)
		).rows;
		return {
			kind:
				fixture.fixtureKind === "synthetic-current-v3-partial-replica"
					? "v3-partial"
					: "v2-partial",
			rows,
			pendingRow: fixture.pendingRow,
		};
	}
	if (fixture.fixtureKind === "synthetic-sparse-v77-full-sync") {
		const rows = (
			await session.lix.execute(
				"SELECT key,value FROM lix_key_value WHERE key='upgrade-test'",
			)
		).rows;
		const sources = await session.lix.replicaRecoverySources();
		const retained = [];
		for (const source of sources) {
			const bundle = await session.lix.exportReplicaRecovery(source.id);
			for (const branch of bundle.branches)
				for (const row of branch.rows) {
					if (
						["offline-recovery", "local-only-upgrade-test"].includes(
							row.snapshot?.key,
						)
					)
						retained.push({ snapshot: row.snapshot, untracked: row.untracked });
				}
		}
		const files = [];
		for (const expected of fixture.files ?? []) {
			const result = await session.lix.execute(
				"SELECT content FROM lix_file WHERE path = $1",
				[expected.path],
			);
			const bytes = result.rows[0]?.content;
			files.push({
				path: expected.path,
				length: bytes?.length,
				matches:
					bytes?.length === expected.length &&
					Array.from(bytes).every(
						(byte, index) =>
							byte ===
							(expected.bytes
								? expected.bytes[index]
								: index % expected.byteModulo),
					),
			});
		}
		const custom = fixture.customSchema
			? (
					await session.lix.execute(
						"SELECT id,value FROM legacy_custom_note WHERE id='legacy'",
					)
				).rows
			: [];
		return {
			kind: "legacy",
			files,
			custom,
			rows,
			pending: fixture.pending,
			retained,
			sources,
		};
	}
	const query =
		"SELECT key,value FROM lix_key_value WHERE key IN ('local','remote') ORDER BY key";
	await session.switchBranch(fixture.branchId);
	const main = (await session.lix.execute(query)).rows;
	const custom = (
		await session.lix.execute(
			"SELECT value FROM migration_custom_note WHERE id='local'",
		)
	).rows;
	const files = (
		await session.lix.execute(
			"SELECT path,content FROM lix_file WHERE path IN ('/local.bin','/remote.bin') ORDER BY path",
		)
	).rows.map((row) => ({ path: row.path, content: Array.from(row.content) }));
	await session.switchBranch(fixture.additionalBranchId);
	const other = (await session.lix.execute(query)).rows;
	await session.switchBranch(fixture.branchId);
	return { kind: "pending", main, custom, files, other };
}
window.migrationQa = {
	seed,
	open,
	values,
	identity,
	mountRecovery: async () => {
		const [{ createElement }, { createRoot }, { ReplicaRecovery }] =
			await Promise.all([
				import("react"),
				import("react-dom/client"),
				import("../../src/components/replica-recovery.tsx"),
			]);
		const container = document.createElement("div");
		document.body.append(container);
		createRoot(container).render(
			createElement(ReplicaRecovery, {
				lix: session.lix,
			}),
		);
	},
	delays: () => delays,
	close: async () => {
		await session?.close();
		session = undefined;
	},
};
