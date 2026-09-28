import { createHash } from "node:crypto";
import { PostHog, type EventMessage } from "posthog-node";
import type { ExecuteRequest, ExecuteResponse } from "../mcp/lix-service.ts";
import { PRODUCT_EVENTS } from "../lib/telemetry-events.ts";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

type Reader = {
	execute(lixId: string, request: ExecuteRequest): Promise<ExecuteResponse>;
};

const INVENTORY_SQL =
	"SELECT path, OCTET_LENGTH(content) AS content_bytes FROM lix_as_of('lix_file', $1)";
const SIZE_BUCKETS = [1_024, 10_240, 102_400, 1_048_576] as const;
const MAX_EXTENSIONS = 20;

export interface RepositoryInventory {
	file_count: number;
	total_content_bytes: number;
	user_file_count: number;
	user_content_bytes: number;
	lix_internal_file_count: number;
	lix_internal_content_bytes: number;
	file_size_under_1kb: number;
	file_size_1kb_to_10kb: number;
	file_size_10kb_to_100kb: number;
	file_size_100kb_to_1mb: number;
	file_size_1mb_and_over: number;
	user_file_size_buckets: Record<string, number>;
	lix_internal_file_size_buckets: Record<string, number>;
	extension_file_counts: Record<string, number>;
	extension_content_bytes: Record<string, number>;
	user_extension_file_counts: Record<string, number>;
	user_extension_content_bytes: Record<string, number>;
	lix_internal_extension_file_counts: Record<string, number>;
	lix_internal_extension_content_bytes: Record<string, number>;
}

/** Measure the committed live tree. No file path or content leaves this function. */
export async function readRepositoryInventory(
	reader: Reader,
	repositoryId: string,
	commitId: string,
): Promise<RepositoryInventory> {
	const result = await reader.execute(repositoryId, {
		sql: INVENTORY_SQL,
		params: [{ kind: "text", value: commitId }],
	});
	const inventory: RepositoryInventory = {
		file_count: 0,
		total_content_bytes: 0,
		user_file_count: 0,
		user_content_bytes: 0,
		lix_internal_file_count: 0,
		lix_internal_content_bytes: 0,
		file_size_under_1kb: 0,
		file_size_1kb_to_10kb: 0,
		file_size_10kb_to_100kb: 0,
		file_size_100kb_to_1mb: 0,
		file_size_1mb_and_over: 0,
		user_file_size_buckets: {},
		lix_internal_file_size_buckets: {},
		extension_file_counts: {},
		extension_content_bytes: {},
		user_extension_file_counts: {},
		user_extension_content_bytes: {},
		lix_internal_extension_file_counts: {},
		lix_internal_extension_content_bytes: {},
	};
	for (const row of result.rows) {
		const [path, bytes] = row;
		if (
			path?.kind !== "text" ||
			bytes?.kind !== "int" ||
			!Number.isSafeInteger(bytes.value) ||
			bytes.value < 0
		)
			throw new Error("Invalid repository inventory result");
		const size = bytes.value;
		const internal = path.value === "/.lix" || path.value.startsWith("/.lix/");
		inventory.file_count++;
		inventory.total_content_bytes += size;
		if (internal) {
			inventory.lix_internal_file_count++;
			inventory.lix_internal_content_bytes += size;
		} else {
			inventory.user_file_count++;
			inventory.user_content_bytes += size;
		}
		if (size < SIZE_BUCKETS[0]) inventory.file_size_under_1kb++;
		else if (size < SIZE_BUCKETS[1]) inventory.file_size_1kb_to_10kb++;
		else if (size < SIZE_BUCKETS[2]) inventory.file_size_10kb_to_100kb++;
		else if (size < SIZE_BUCKETS[3]) inventory.file_size_100kb_to_1mb++;
		else inventory.file_size_1mb_and_over++;
		const bucket =
			size < SIZE_BUCKETS[0]
				? "under_1kb"
				: size < SIZE_BUCKETS[1]
					? "1kb_to_10kb"
					: size < SIZE_BUCKETS[2]
						? "10kb_to_100kb"
						: size < SIZE_BUCKETS[3]
							? "100kb_to_1mb"
							: "1mb_and_over";
		const classBuckets = internal
			? inventory.lix_internal_file_size_buckets
			: inventory.user_file_size_buckets;
		classBuckets[bucket] = (classBuckets[bucket] ?? 0) + 1;
		const name = path.value.split("/").pop() ?? "";
		const raw = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "(none)";
		const extension = /^[a-z0-9+_-]{1,20}$/.test(raw) ? raw : "(other)";
		inventory.extension_file_counts[extension] =
			(inventory.extension_file_counts[extension] ?? 0) + 1;
		inventory.extension_content_bytes[extension] =
			(inventory.extension_content_bytes[extension] ?? 0) + size;
		const classCounts = internal
			? inventory.lix_internal_extension_file_counts
			: inventory.user_extension_file_counts;
		const classBytes = internal
			? inventory.lix_internal_extension_content_bytes
			: inventory.user_extension_content_bytes;
		classCounts[extension] = (classCounts[extension] ?? 0) + 1;
		classBytes[extension] = (classBytes[extension] ?? 0) + size;
	}
	if (!Number.isSafeInteger(inventory.total_content_bytes))
		throw new Error("Repository inventory exceeds safe byte count");
	for (const [counts, bytes] of [
		[inventory.extension_file_counts, inventory.extension_content_bytes],
		[
			inventory.user_extension_file_counts,
			inventory.user_extension_content_bytes,
		],
		[
			inventory.lix_internal_extension_file_counts,
			inventory.lix_internal_extension_content_bytes,
		],
	] as const) {
		const topExtensions = Object.entries(counts)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, MAX_EXTENSIONS)
			.map(([extension]) => extension);
		for (const extension of Object.keys(counts)) {
			if (extension === "(other)" || topExtensions.includes(extension))
				continue;
			counts["(other)"] = (counts["(other)"] ?? 0) + counts[extension]!;
			bytes["(other)"] = (bytes["(other)"] ?? 0) + bytes[extension]!;
			delete counts[extension];
			delete bytes[extension];
		}
	}
	return inventory;
}

export async function captureRepositoryInventory(
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
		commitId: string;
		surface: "web" | "mcp";
		isDemo?: boolean;
		inventory: RepositoryInventory;
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
	const snapshotDate = new Date().toISOString().slice(0, 10);
	const digest = createHash("sha256")
		.update(
			`repository_inventory_snapshot:${input.repositoryId}:${input.commitId}:${snapshotDate}`,
		)
		.digest("hex");
	const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
	const client = createClient(
		token,
		env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
	);
	try {
		await client.captureImmediate({
			distinctId: input.userId,
			event: PRODUCT_EVENTS.repositoryInventorySnapshot,
			uuid,
			properties: {
				...input.inventory,
				repository_id: input.repositoryId,
				lix_id: input.repositoryId,
				snapshot_date: snapshotDate,
				$groups: { repository: input.repositoryId },
				telemetry_schema_version: 1,
				surface: input.surface,
				environment: "production",
			},
		} satisfies EventMessage);
	} finally {
		await client.shutdown();
	}
}
