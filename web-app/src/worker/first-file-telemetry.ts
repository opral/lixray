import { PostHog, type EventMessage } from "posthog-node";
import type {
	CommitSpan,
	ExecuteRequest,
	ExecuteResponse,
} from "../mcp/lix-service.ts";
import { PRODUCT_EVENTS } from "../lib/telemetry-events.ts";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

type SnapshotReader = {
	execute(lixId: string, request: ExecuteRequest): Promise<ExecuteResponse>;
};

/** A commit is the source of truth: a request or browser tab is not a repository milestone. */
export async function addedFirstFile(
	reader: SnapshotReader,
	lixId: string,
	commit: CommitSpan,
): Promise<string | null> {
	if (!commit.before || !commit.after || commit.before === commit.after)
		return null;
	const countAt = async (commitId: string): Promise<number> => {
		const result = await reader.execute(lixId, {
			sql: "SELECT COUNT(*) AS file_count FROM lix_as_of('lix_file', $1)",
			params: [{ kind: "text", value: commitId }],
		});
		const value = result.rows[0]?.[0];
		if (value?.kind !== "int" || !Number.isSafeInteger(value.value)) {
			throw new Error("Invalid first-file inventory result");
		}
		return value.value;
	};
	const before = await countAt(commit.before);
	if (before !== 0) return null;
	const after = await reader.execute(lixId, {
		sql: "SELECT path FROM lix_as_of('lix_file', $1) ORDER BY path LIMIT 1",
		params: [{ kind: "text", value: commit.after }],
	});
	const path = after.rows[0]?.[0];
	return path?.kind === "text" && path.value ? path.value : null;
}

export async function captureFirstFileAdded(
	env: {
		POSTHOG_PROJECT_TOKEN?: string;
		VITE_PUBLIC_POSTHOG_TOKEN?: string;
		POSTHOG_HOST?: string;
		POSTHOG_ENVIRONMENT?: string;
		VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
		LIXRAY_DEMO?: string;
		RAILWAY_ENVIRONMENT_NAME?: string;
	},
	input: {
		userId: string;
		repositoryId: string;
		fileExtension: string;
		surface: "web" | "mcp";
		isDemo?: boolean;
	},
	createClient: (
		token: string,
		host: string,
	) => Pick<PostHog, "captureImmediate" | "shutdown"> = (token, host) =>
		new PostHog(token, { host, flushAt: 1, flushInterval: 0 }),
): Promise<void> {
	const token = resolvePosthogProjectToken(env);
	if (
		!token ||
		!isProductionTelemetryEnvironment(env) ||
		input.isDemo ||
		isDemoEnvironment(env)
	)
		return;
	const client = createClient(
		token,
		env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
	);
	try {
		await client.captureImmediate({
			distinctId: input.userId,
			event: PRODUCT_EVENTS.firstFileAdded,
			// PostHog deduplicates this UUID across browser and MCP retries.
			uuid: input.repositoryId,
			properties: {
				repository_id: input.repositoryId,
				lix_id: input.repositoryId,
				file_extension: input.fileExtension,
				telemetry_schema_version: 2,
				surface: input.surface,
				environment: "production",
			},
		} satisfies EventMessage);
	} finally {
		await client.shutdown();
	}
}
