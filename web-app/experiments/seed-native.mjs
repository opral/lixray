import { randomUUID } from "node:crypto";
import { openLix } from "@lix-js/sdk";

const defaultLixOrigin = "http://127.0.0.1:18309";
const accountId = "00000000-0000-4000-8000-000000000031";

function nonNegativeCount(value, name) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${name} must be a non-negative safe integer`);
	return value;
}

/**
 * Seed an isolated repository for the native-only browser prototype.
 * `unrelatedHistory` is an optional number of extra writes to an unrelated
 * file. When unrelatedFiles is zero, a temporary file is removed afterward so
 * the final file count remains zero.
 */
export async function seedNative({
	bytes = 1024,
	unrelatedFiles = 0,
	unrelatedHistory = 0,
	delayMs = 0,
} = {}) {
	bytes = nonNegativeCount(bytes, "bytes");
	unrelatedFiles = nonNegativeCount(unrelatedFiles, "unrelatedFiles");
	unrelatedHistory = nonNegativeCount(unrelatedHistory, "unrelatedHistory");
	delayMs = nonNegativeCount(delayMs, "delayMs");
	if (bytes !== 1024)
		throw new RangeError(
			"The native profile fixture target must be exactly 1024 bytes",
		);

	const repositoryId = randomUUID();
	const endpoint = process.env.PROTOTYPE_LIX_ORIGIN?.trim() || defaultLixOrigin;
	const headers = {
		Authorization: "Bearer lixray-local-internal-token",
		"x-lix-account-id": accountId,
		"x-lix-idempotency-scope": "prototype:account",
	};
	const provision = await fetch(
		`${endpoint}/internal/repositories/${repositoryId}/provision`,
		{
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "create-new" }),
		},
	);
	if (!provision.ok)
		throw new Error(
			`Local native prototype provision failed: HTTP ${provision.status}`,
		);

	const lix = await openLix({
		server: { mode: "remote", url: `${endpoint}/lix/${repositoryId}`, headers },
	});
	try {
		const unrelatedPayload = (index) => {
			const identity = `unrelated-file-${String(index).padStart(6, "0")}:`;
			return (identity + "b".repeat(bytes)).slice(0, bytes);
		};
		await lix.execute(
			"INSERT INTO lix_file(path,content) VALUES($1,CAST($2 AS BYTEA))",
			["/prototype.txt", "a".repeat(bytes)],
		);

		for (let offset = 0; offset < unrelatedFiles; offset += 100) {
			await lix.executeBatch(
				Array.from(
					{ length: Math.min(100, unrelatedFiles - offset) },
					(_, index) => ({
						sql: "INSERT INTO lix_file(path,content) VALUES($1,CAST($2 AS BYTEA))",
						params: [
							`/unrelated/file-${offset + index}.txt`,
							unrelatedPayload(offset + index),
						],
					}),
				),
			);
		}

		if (unrelatedHistory > 0) {
			const temporaryHistoryFile = unrelatedFiles === 0;
			const historyPath = temporaryHistoryFile
				? "/unrelated/history-temporary.txt"
				: "/unrelated/file-0.txt";
			if (temporaryHistoryFile) {
				await lix.execute(
					"INSERT INTO lix_file(path,content) VALUES($1,CAST($2 AS BYTEA))",
					[historyPath, "h"],
				);
			}
			for (let revision = 0; revision < unrelatedHistory; revision++) {
				await lix.execute(
					"UPDATE lix_file SET content=CAST($1 AS BYTEA) WHERE path=$2",
					[`history-${revision}`, historyPath],
				);
			}
			if (temporaryHistoryFile) {
				await lix.execute("DELETE FROM lix_file WHERE path=$1", [historyPath]);
			}
		}

		const fileId = (
			await lix.execute("SELECT id FROM lix_file WHERE path=$1", [
				"/prototype.txt",
			])
		).rows[0]?.id;
		if (typeof fileId !== "string")
			throw new Error("Native prototype target file was not created");
		const branchId = await lix.activeBranchId();
		return {
			repositoryId,
			branchId,
			fileId,
			bytes,
			unrelatedFiles,
			unrelatedHistory,
			delayMs,
		};
	} finally {
		await lix.close();
	}
}

if (process.argv[1]?.endsWith("seed-native.mjs")) {
	const fixture = await seedNative({
		bytes: 1024,
		unrelatedFiles: Number(process.env.PROTOTYPE_UNRELATED_FILES ?? 0),
		unrelatedHistory: Number(process.env.PROTOTYPE_UNRELATED_HISTORY ?? 0),
	});
	const previewOrigin =
		process.env.PROTOTYPE_PREVIEW_ORIGIN?.trim() || "http://127.0.0.1:8830";
	console.log(
		`${previewOrigin}/native.html?${new URLSearchParams({
			repositoryId: fixture.repositoryId,
			branchId: fixture.branchId,
			fileId: fixture.fileId,
		})}`,
	);
}
