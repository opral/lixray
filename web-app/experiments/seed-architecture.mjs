import { openLix } from "@lix-js/sdk";
import { randomUUID } from "node:crypto";

export async function seedArchitecture({
	bytes = 1024,
	unrelatedFiles = 0,
} = {}) {
	const repositoryId = randomUUID();
	const endpoint = "http://127.0.0.1:18309";
	const headers = {
		Authorization: "Bearer lixray-local-internal-token",
		"x-lix-account-id": "00000000-0000-4000-8000-000000000031",
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
			`Local prototype provision failed: HTTP ${provision.status}`,
		);
	const lix = await openLix({
		server: { mode: "remote", url: `${endpoint}/lix/${repositoryId}`, headers },
	});
	try {
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
						params: [`/unrelated/file-${offset + index}.txt`, "b".repeat(1024)],
					}),
				),
			);
		}
		const fileId = (
			await lix.execute("SELECT id FROM lix_file WHERE path=$1", [
				"/prototype.txt",
			])
		).rows[0].id;
		const branchId = await lix.activeBranchId();
		return { repositoryId, branchId, fileId, bytes, unrelatedFiles };
	} finally {
		await lix.close();
	}
}

if (process.argv[1]?.endsWith("seed-architecture.mjs")) {
	const fixture = await seedArchitecture({
		bytes: Number(process.env.PROTOTYPE_BYTES ?? 1024),
		unrelatedFiles: Number(process.env.PROTOTYPE_UNRELATED_FILES ?? 0),
	});
	console.log(
		`http://127.0.0.1:8830/architecture.html?${new URLSearchParams({ repositoryId: fixture.repositoryId, branchId: fixture.branchId, fileId: fixture.fileId })}`,
	);
	process.exit(0);
}
