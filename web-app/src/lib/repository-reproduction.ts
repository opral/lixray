import type { Lix } from "@lix-js/sdk";
import { strToU8, zipSync } from "fflate";

export async function buildRepositoryReproduction({
	localLix,
	remoteSnapshot,
	query,
	diffCsv,
}: {
	readonly localLix: Lix;
	readonly remoteSnapshot: () => Promise<Blob>;
	readonly query: string;
	readonly diffCsv: string;
}): Promise<Blob> {
	const [localSnapshotBlob, remoteSnapshotBlob] = await Promise.all([
		new Response(localLix.exportSnapshot(), {
			headers: { "Content-Type": "application/vnd.lix.snapshot" },
		}).blob(),
		remoteSnapshot(),
	]);
	const [localSnapshot, remoteSnapshotBytes] = await Promise.all([
		blobBytes(localSnapshotBlob),
		blobBytes(remoteSnapshotBlob),
	]);
	const archive = zipSync({
		"query.sql": strToU8(`${query.trim()}\n`),
		"diff.csv": strToU8(diffCsv),
		"local.lixsnap": localSnapshot,
		"remote.lixsnap": remoteSnapshotBytes,
	});
	return new Blob([archive], { type: "application/zip" });
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await blob.arrayBuffer());
}
