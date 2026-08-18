import { PostHog, type EventMessage } from "posthog-node";
import type { McpExecuteInputObservation } from "../mcp/tool-observation.ts";
import { createHash } from "node:crypto";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface LixrMcpTelemetryEnvironment {
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_GIT_COMMIT_SHA?: string;
}

interface LixrMcpTelemetryIdentity {
	userId: string;
	clientId: string;
	isDemo?: boolean;
}

export interface LixrMcpTelemetrySession {
	captureConnected(properties: {
		serverUrl: string;
		oauthResult: "success" | "failure";
		tokenLengthChars?: number;
		lixId?: string;
	}): void;

	captureToolCalled(properties: {
		toolName: string;
		sqlOp?: string;
		isBulk: boolean;
		rowCount: number;
		durationMs: number;
		requestBytes: number;
		isError: boolean;
		errorCode?: string;
		lixId?: string;
	}): void;

	captureFileWritten(properties: {
		path: string;
		extension: string;
		bytes: number;
		chars: number;
		contentSha256: string;
		writeMode: "single_row" | "bulk";
		source: "mcp" | "ui" | "onboarding_injected";
		lixId?: string;
	}): void;

	captureFileWriteVerified(properties: {
		path: string;
		lengthChars: number;
		lengthBytes: number;
		hashMatch: boolean;
		lixId?: string;
	}): void;

	captureLixRequestSucceeded(properties: {
		lixRequestEndpoint: string;
		lixRequestMethod: string;
		lixHttpStatus: number;
		lixId?: string;
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
	const token = env.POSTHOG_PROJECT_TOKEN?.trim();
	if (!token || env.POSTHOG_ENVIRONMENT !== "production" || identity.isDemo) {
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
	): void => {
		const baseProperties = {
			...properties,
			oauth_client_id: identity.clientId,
			environment: "production",
			release_id: releaseId,
		};

		try {
			const capture = client
				.captureImmediate({
					distinctId: identity.userId,
					event,
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
		captureConnected(properties) {
			captureEvent("mcp_connected", properties, properties.lixId);
		},

		captureToolCalled(properties) {
			captureEvent("mcp_tool_called", properties, properties.lixId);
		},

		captureFileWritten(properties) {
			captureEvent("file_written", properties, properties.lixId);
		},

		captureFileWriteVerified(properties) {
			captureEvent("file_write_verified", properties, properties.lixId);
		},

		captureLixRequestSucceeded(properties) {
			captureEvent("lix_request_succeeded", properties, properties.lixId);
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

export function analyzeSqlOperation(
	executeInput: McpExecuteInputObservation,
): {
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
			const content = extractContentFromParams(stmt.params);
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
