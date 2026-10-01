import type { McpToolCallObservation } from "../mcp/server.ts";
import { PostHog, type EventMessage } from "posthog-node";
import type { McpExecuteInputObservation } from "../mcp/tool-observation.ts";
import { PRODUCT_EVENTS } from "../lib/telemetry-events.ts";
import { createHash } from "node:crypto";
import {
	isDemoEnvironment,
	isProductionTelemetryEnvironment,
	resolvePosthogProjectToken,
} from "./mcp-posthog-env.ts";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface LixrMcpTelemetryEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	VITE_PUBLIC_POSTHOG_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
	LIXRAY_DEMO?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	RAILWAY_GIT_COMMIT_SHA?: string;
}

interface LixrMcpTelemetryIdentity {
	userId: string;
	clientId: string;
	isDemo?: boolean;
}

export interface LixrMcpTelemetrySession {
	captureToolFailure(observation: McpToolCallObservation): void;
	captureFileWritten(properties: {
		file_extension: string;
		char_count: number;
		byte_count: number;
		content_sha256: string;
		is_bulk: boolean;
		source: "mcp" | "ui" | "onboarding_injected";
		verified: boolean;
		hash_match: boolean;
		lix_id?: string;
		repository_id?: string;
		organization_id?: string;
	}): void;

	captureImportCompleted(properties: {
		file_count: number;
		char_count: number;
		byte_count: number;
		tool_call_count: number;
		duration_ms: number;
		is_bulk: boolean;
		lix_id?: string;
		repository_id?: string;
	}): void;

	flush(): Promise<void>;
}

interface PostHogCaptureClient {
	captureImmediate(event: EventMessage): Promise<void>;
	shutdown(): Promise<void>;
}

interface LixrMcpTelemetryDependencies {
	createClient?: (
		token: string,
		options: { host: string; flushAt: number; flushInterval: number },
	) => PostHogCaptureClient;
	warn?: (message: string, error: unknown) => void;
}

export function createLixrMcpTelemetrySession(
	env: LixrMcpTelemetryEnvironment,
	identity: LixrMcpTelemetryIdentity,
	dependencies: LixrMcpTelemetryDependencies = {},
): LixrMcpTelemetrySession | null {
	const token = resolvePosthogProjectToken(env);
	if (
		!token ||
		!isProductionTelemetryEnvironment(env) ||
		identity.isDemo ||
		isDemoEnvironment(env)
	) {
		return null;
	}

	const warn =
		dependencies.warn ??
		((message: string, error: unknown) => console.warn(message, error));
	let client: PostHogCaptureClient;
	try {
		client = (dependencies.createClient ?? createPostHogClient)(token, {
			host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
		});
	} catch (caught) {
		warn("Failed to initialize Lixr MCP telemetry", caught);
		return null;
	}

	const pendingCaptures: Array<Promise<void>> = [];
	const releaseId =
		env.LIXRAY_RELEASE_ID?.trim() ||
		env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
		"unknown";

	const captureEvent = (
		event: string,
		properties: Record<string, unknown>,
		lixId?: string,
		uuid?: string,
	): void => {
		const baseProperties = {
			...properties,
			surface: "mcp",
			oauth_client_id: identity.clientId,
			environment: "production",
			release_id: releaseId,
		};

		try {
			const capture = client
				.captureImmediate({
					distinctId: identity.userId,
					event,
					...(uuid ? { uuid } : {}),
					properties: baseProperties,
					...(lixId ? { groups: { lix: lixId } } : {}),
				})
				.catch((caught: unknown) => {
					warn("Failed to capture Lixr MCP telemetry", caught);
				});
			pendingCaptures.push(capture);
		} catch (caught) {
			warn("Failed to capture Lixr MCP telemetry", caught);
		}
	};

	return {
		captureToolFailure(observation) {
			if (
				observation.outcome !== "error" ||
				observation.exceptionOwner === "protocol"
			)
				return;
			const { traceId, spanId, toolName, requestId } = observation;
			if (!traceId || !spanId) return;
			const code =
				observation.errorCode &&
				/^(?:LIX_[A-Z0-9_]{1,100}|[a-z_]{1,100})$/.test(observation.errorCode)
					? observation.errorCode
					: "mcp_tool_failed";
			const rustOriginCauseIndex = observation.exceptionRustOriginCauseIndex;
			const safeRustOriginCauseIndex =
				typeof rustOriginCauseIndex === "number" &&
				Number.isSafeInteger(rustOriginCauseIndex) &&
				rustOriginCauseIndex >= 0 &&
				rustOriginCauseIndex <= 3
					? rustOriginCauseIndex
					: undefined;
			// Never capture thrown messages or raw stacks: engine errors can contain SQL or values.
			const digest = createHash("sha256")
				.update(`mcp-error:${traceId}:${spanId}`)
				.digest();
			digest[6] = (digest[6]! & 0x0f) | 0x80;
			digest[8] = (digest[8]! & 0x3f) | 0x80;
			const id = digest.subarray(0, 16).toString("hex");
			const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
			captureEvent(
				"$exception",
				{
					$exception_list: [
						{
							type: observation.resultEncodingType
								? "McpResultEncodingError"
								: code,
							value: observation.resultEncodingType
								? `MCP ${toolName} result encoding failed (${observation.resultEncodingType})`
								: `MCP ${toolName} failed (${code})`,
							...(observation.exceptionStacktrace
								? { stacktrace: observation.exceptionStacktrace }
								: {}),
							mechanism: { type: "generic", handled: true },
						},
					],
					$exception_level: "error",
					$exception_source: "mcp",
					$process_person_profile: false,
					$geoip_disable: true,
					...(observation.exceptionRustOrigin
						? { rust_origin: observation.exceptionRustOrigin }
						: {}),
					...(safeRustOriginCauseIndex !== undefined
						? { rust_origin_cause_index: safeRustOriginCauseIndex }
						: {}),
					...(observation.exceptionRustStacktraceStatus
						? {
								rust_stacktrace_status:
									observation.exceptionRustStacktraceStatus,
							}
						: {}),
					$otel_trace_id: traceId,
					$otel_span_id: spanId,
					$ai_trace_id: traceId,
					$ai_span_id: spanId,
					request_id: requestId,
					operation: toolName,
					error_code: code,
					...(observation.commitOutcome
						? { commit_outcome: observation.commitOutcome }
						: {}),
					...(observation.lixId
						? { lix_id: observation.lixId, repository_id: observation.lixId }
						: {}),
				},
				observation.lixId,
				uuid,
			);
		},
		captureFileWritten(properties) {
			captureEvent(PRODUCT_EVENTS.fileWritten, properties, properties.lix_id);
		},

		captureImportCompleted(properties) {
			captureEvent(
				PRODUCT_EVENTS.importCompleted,
				properties,
				properties.lix_id,
			);
		},

		async flush(): Promise<void> {
			await Promise.all(pendingCaptures);
			try {
				await client.shutdown();
			} catch (caught) {
				warn("Failed to shut down Lixr MCP telemetry", caught);
			}
		},
	};
}

function createPostHogClient(
	token: string,
	options: { host: string; flushAt: number; flushInterval: number },
): PostHogCaptureClient {
	return new PostHog(token, options);
}

export function analyzeSqlOperation(executeInput: McpExecuteInputObservation): {
	operation: string;
	isBulk: boolean;
	estimatedRowCount: number;
} {
	const operations = executeInput.statements.map((s) => s.operation);
	const primaryOp = operations[0] ?? "UNKNOWN";
	const isBulk = executeInput.statementCount > 1;

	let estimatedRowCount = 0;
	for (const stmt of executeInput.statements) {
		if (stmt.operation === "INSERT" || stmt.operation === "UPDATE") {
			estimatedRowCount += 1;
		}
	}

	return {
		operation: primaryOp,
		isBulk,
		estimatedRowCount,
	};
}

export function detectFileWrites(
	statements: Array<{ sql: string; params?: Array<unknown> }>,
): Array<{
	path: string;
	operation: "insert" | "update" | "delete";
	content?: string;
}> {
	const fileWrites: Array<{
		path: string;
		operation: "insert" | "update" | "delete";
		content?: string;
	}> = [];

	for (const stmt of statements) {
		const sql = stmt.sql.toLowerCase().trim();

		if (
			sql.includes("insert into lix_file") ||
			sql.includes("insert into public.lix_file")
		) {
			const pathMatch = extractPathFromSql(stmt);
			const contentIndex = extractContentIndexFromInsert(sql);
			const content =
				contentIndex !== null
					? extractContentFromParamsByIndex(stmt.params, contentIndex)
					: extractContentFromParams(stmt.params);
			if (pathMatch) {
				fileWrites.push({ path: pathMatch, operation: "insert", content });
			}
		} else if (
			sql.includes("update lix_file") ||
			sql.includes("update public.lix_file")
		) {
			const pathMatch = extractPathFromSql(stmt);
			const content = extractContentFromParams(stmt.params);
			if (pathMatch) {
				fileWrites.push({ path: pathMatch, operation: "update", content });
			}
		} else if (
			sql.includes("delete from lix_file") ||
			sql.includes("delete from public.lix_file")
		) {
			const pathMatch = extractPathFromSql(stmt);
			if (pathMatch) {
				fileWrites.push({ path: pathMatch, operation: "delete" });
			}
		}
	}

	return fileWrites;
}

function extractPathFromSql(stmt: {
	sql: string;
	params?: Array<unknown>;
}): string | null {
	const sql = stmt.sql.toLowerCase();

	// Handle INSERT: extract from column list
	if (sql.includes("insert into")) {
		const columnsMatch = sql.match(/\(([^)]+)\)\s*values/);
		if (columnsMatch?.[1] && stmt.params) {
			const columns = columnsMatch[1].split(",").map((col) => col.trim());
			const pathIndex = columns.indexOf("path");
			if (pathIndex !== -1) {
				const param = stmt.params[pathIndex];
				if (
					param &&
					typeof param === "object" &&
					"kind" in param &&
					param.kind === "text" &&
					"value" in param &&
					typeof param.value === "string"
				) {
					return param.value;
				}
			}
		}
	}

	// Handle UPDATE/DELETE: extract from WHERE clause
	if (sql.includes("path =")) {
		const pathParamMatch = sql.match(/path\s*=\s*\$(\d+)/);
		if (pathParamMatch && stmt.params) {
			const paramIndex = Number.parseInt(pathParamMatch[1] ?? "0", 10) - 1;
			const param = stmt.params[paramIndex];
			if (
				param &&
				typeof param === "object" &&
				"kind" in param &&
				param.kind === "text" &&
				"value" in param &&
				typeof param.value === "string"
			) {
				return param.value;
			}
		}

		const pathLiteralMatch = sql.match(/path\s*=\s*'([^']+)'/);
		if (pathLiteralMatch?.[1]) {
			return pathLiteralMatch[1];
		}
	}

	return null;
}

function extractContentIndexFromInsert(sql: string): number | null {
	const columnsMatch = sql.match(/\(([^)]+)\)\s*values/);
	if (columnsMatch?.[1]) {
		const columns = columnsMatch[1].split(",").map((col) => col.trim());
		const contentIndex = columns.indexOf("content");
		if (contentIndex !== -1) {
			return contentIndex;
		}
	}
	return null;
}

function extractContentFromParamsByIndex(
	params: Array<unknown> | undefined,
	index: number,
): string | undefined {
	if (!params || index < 0 || index >= params.length) return undefined;
	const param = params[index];
	if (
		param &&
		typeof param === "object" &&
		"kind" in param &&
		param.kind === "text" &&
		"value" in param &&
		typeof param.value === "string"
	) {
		return param.value;
	}
	return undefined;
}

function extractContentFromParams(
	params: Array<unknown> | undefined,
): string | undefined {
	if (!params) return undefined;

	for (const param of params) {
		if (
			param &&
			typeof param === "object" &&
			"kind" in param &&
			param.kind === "text" &&
			"value" in param &&
			typeof param.value === "string" &&
			param.value.length > 100
		) {
			return param.value;
		}
	}

	return undefined;
}

export function computeContentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function getFileExtension(path: string): string {
	const match = path.match(/\.([^./]+)$/);
	return match?.[1] ?? "";
}
