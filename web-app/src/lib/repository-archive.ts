import { openLix, type Lix } from "@lix-js/sdk";
import { zipSync } from "fflate";

type AccessTokenGetter = () => Promise<string | null>;

interface RepositoryRemote {
	repositoryId: string;
	getAccessToken: AccessTokenGetter;
}

export async function fetchRepositoryFileCount(
	options: RepositoryRemote,
): Promise<number> {
	return withRepositoryLix(options, async (lix) => {
		const result = await lix.execute("SELECT COUNT(*) AS count FROM lix_file");
		const count = result.rows[0]?.count;
		return typeof count === "number" ? count : 0;
	});
}

export async function buildRepositoryArchive(
	options: RepositoryRemote,
): Promise<Uint8Array<ArrayBuffer>> {
	return withRepositoryLix(options, async (lix) => {
		const result = await lix.execute(
			"SELECT path, content FROM lix_file ORDER BY path",
		);
		const entries: Record<string, Uint8Array> = {};
		for (const row of result.rows) {
			const path = row.path;
			const content = row.content;
			if (typeof path !== "string" || !(content instanceof Uint8Array)) {
				throw new Error("Repository archive returned invalid file data.");
			}
			const archivePath = path.replace(/^\/+/, "");
			if (archivePath) entries[archivePath] = content;
		}
		return zipSync(entries);
	});
}

async function withRepositoryLix<T>(
	options: RepositoryRemote,
	operation: (lix: Lix) => Promise<T>,
): Promise<T> {
	const lix = await openLix({
		server: {
			url: new URL(
				`/lix/${encodeURIComponent(options.repositoryId)}`,
				globalThis.location.origin,
			),
			headers: async () => {
				const token = await options.getAccessToken();
				if (!token) throw new Error("Sign in to access this repository.");
				return { Authorization: `Bearer ${token}` };
			},
		},
	});
	try {
		return await operation(lix);
	} finally {
		await lix.close();
	}
}
