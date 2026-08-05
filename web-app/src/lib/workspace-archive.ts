import { openLix, type Lix } from "@lix-js/sdk";
import { zipSync } from "fflate";

type AccessTokenGetter = () => Promise<string | null>;

interface WorkspaceRemote {
	namespace: string;
	workspaceSlug: string;
	getAccessToken: AccessTokenGetter;
}

export async function fetchWorkspaceFileCount(
	options: WorkspaceRemote,
): Promise<number> {
	return withWorkspaceLix(options, async (lix) => {
		const result = await lix.execute("SELECT COUNT(*) AS count FROM lix_file");
		const count = result.rows[0]?.toObject().count;
		return typeof count === "number" ? count : 0;
	});
}

export async function buildWorkspaceArchive(
	options: WorkspaceRemote,
): Promise<Uint8Array<ArrayBuffer>> {
	return withWorkspaceLix(options, async (lix) => {
		const result = await lix.execute(
			"SELECT path, content FROM lix_file ORDER BY path",
		);
		const entries: Record<string, Uint8Array> = {};
		for (const row of result.rows) {
			const path = row.value("path").toJS();
			const content = row.value("content").asBytes();
			if (typeof path !== "string" || !content) {
				throw new Error("Workspace archive returned invalid file data.");
			}
			const archivePath = path.replace(/^\/+/, "");
			if (archivePath) entries[archivePath] = content;
		}
		return zipSync(entries);
	});
}

async function withWorkspaceLix<T>(
	options: WorkspaceRemote,
	operation: (lix: Lix) => Promise<T>,
): Promise<T> {
	const lix = await openLix({
		server: {
			mode: "remote",
			url: new URL(
				`/@${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.workspaceSlug)}`,
				globalThis.location.origin,
			),
			headers: async () => {
				const token = await options.getAccessToken();
				if (!token) throw new Error("Sign in to access this workspace.");
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
