import type { Lix } from "@lix-js/sdk";
import { strToU8, zipSync } from "fflate";

export async function buildRepositoryReproduction({
	localLix,
	remoteSnapshot,
	query,
	diffCsv,
	selectedBranchIdAtSnapshotStart = null,
}: {
	readonly localLix: Lix;
	readonly remoteSnapshot: () => Promise<Blob>;
	readonly query: string;
	readonly diffCsv: string;
	readonly selectedBranchIdAtSnapshotStart?: string | null;
}): Promise<Blob> {
	const snapshotCaptureStartedAt = new Date().toISOString();
	const results = await Promise.allSettled([
		Promise.resolve().then(async () =>
			blobBytes(await new Response(localLix.exportSnapshot()).blob()),
		),
		Promise.resolve().then(async () => blobBytes(await remoteSnapshot())),
	]);
	const files: Record<string, Uint8Array> = {
		"query.sql": strToU8(`${query.trim()}\n`),
		"diff.csv": strToU8(diffCsv),
		"context.json": strToU8(
			`${JSON.stringify(
				{
					selectedBranchIdAtSnapshotStart,
					snapshotCaptureStartedAt,
					snapshotCaptureCompletedAt: new Date().toISOString(),
					comparisonBranchId: null,
					comparisonCapturedAt: null,
					note: "Snapshots are captured after the comparison, independently of each other. The comparison branch and time are unavailable.",
				},
				null,
				2,
			)}\n`,
		),
	};
	const errors: Record<string, string> = {};
	for (const [index, target] of ["local", "remote"].entries()) {
		const result = results[index]!;
		if (result.status === "fulfilled") {
			files[`${target}.lixsnap`] = result.value;
		} else {
			const reason: unknown = result.reason;
			errors[target] =
				reason instanceof Error ? reason.message : String(reason);
		}
	}
	// A failed export must not discard the query, diff, or the other snapshot.
	// Record failures explicitly instead of presenting an incomplete snapshot.
	if (Object.keys(errors).length > 0) {
		files["export-errors.json"] = strToU8(
			`${JSON.stringify(errors, null, 2)}\n`,
		);
	}
	const archive = zipSync(files);
	return new Blob([archive], { type: "application/zip" });
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await blob.arrayBuffer());
}
