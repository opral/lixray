import {
	type CreateBranchInput,
	type CreateBranchResult,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	type WireValue,
	createLixError,
} from "./lix-service.ts";

const PROTOCOL_ORIGIN = "https://mcp.lixray.invalid";
const PROTOCOL_VERSION = 2;
export const LIX_SESSION_HEADER = "lix-session-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export type ProtocolFetch = (
	path: string,
	request: Request,
) => Promise<Response>;

export interface ProtocolSession {
	activeBranchId(): string;
	switchBranch(branchId: string): Promise<{ branchId: string }>;
	execute(request: ExecuteRequest): Promise<ExecuteResponse>;
	executeBatch(request: ExecuteBatchRequest): Promise<ExecuteScriptResponse>;
	createBranch(input: CreateBranchInput): Promise<CreateBranchResult>;
	createCheckpoint(): Promise<{ commitId: string }>;
	undo(): Promise<{
		branchId: string;
		targetCommitId: string;
		inverseCommitId: string;
	}>;
	redo(): Promise<{
		branchId: string;
		targetCommitId: string;
		replayCommitId: string;
	}>;
	mergeBranchPreview(sourceBranchId: string): Promise<Record<string, unknown>>;
	mergeBranch(sourceBranchId: string): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

/**
 * Talks Lix Server Protocol over HTTP. Railway MCP must not load the JS SDK
 * remote WASM binding; that file open is what production open_lix still hits.
 */
export async function openProtocolSession(
	protocolFetch: ProtocolFetch,
): Promise<ProtocolSession> {
	const handshake = await readJson<HandshakeBody>(
		await protocolFetch(
			"/lix/v1/",
			new Request(new URL("/lix/v1/", PROTOCOL_ORIGIN), { method: "GET" }),
		),
	);
	if (handshake.protocolVersion !== PROTOCOL_VERSION) {
		throw createLixError(
			"upstream_error",
			`unsupported Lix Server Protocol version: ${String(handshake.protocolVersion)}`,
		);
	}
	if (!isNonEmptyString(handshake.activeBranchId)) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol handshake requires activeBranchId",
		);
	}
	if (!isNonEmptyString(handshake.sessionId)) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol handshake requires a valid sessionId",
		);
	}

	let closed = false;
	let currentBranchId = handshake.activeBranchId;
	const sessionId = handshake.sessionId;

	const send = (
		path: string,
		init: RequestInit & { idempotent?: boolean } = {},
	): Promise<Response> => {
		if (closed) {
			throw createLixError("upstream_error", "Lix client is closed.");
		}
		const headers = new Headers(init.headers);
		headers.set(LIX_SESSION_HEADER, sessionId);
		if (init.idempotent) {
			headers.set(IDEMPOTENCY_KEY_HEADER, crypto.randomUUID());
		}
		return protocolFetch(
			path,
			new Request(new URL(path, PROTOCOL_ORIGIN), { ...init, headers }),
		);
	};

	return {
		activeBranchId() {
			if (closed) {
				throw createLixError("upstream_error", "Lix client is closed.");
			}
			return currentBranchId;
		},
		async switchBranch(branchId) {
			const body = await readJson<{ branchId: string }>(
				await send("/lix/v1/branch/switch", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ branchId }),
				}),
			);
			if (body.branchId !== branchId) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol switch branch response is invalid",
				);
			}
			currentBranchId = body.branchId;
			return { branchId: body.branchId };
		},
		async execute(request) {
			return decodeExecuteResponse(
				await readJson(
					await send("/lix/v1/execute", {
						method: "POST",
						idempotent: true,
						headers: { "content-type": "application/json" },
						body: JSON.stringify(encodeExecuteRequest(request)),
					}),
				),
			);
		},
		async executeBatch(request) {
			const body = await readJson(
				await send("/lix/v1/execute-batch", {
					method: "POST",
					idempotent: true,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						statements: request.statements.map((statement) => ({
							sql: statement.sql,
							params: (statement.params ?? []).map(toProtocolParam),
						})),
						...(request.options ? { options: request.options } : {}),
					}),
				}),
			);
			if (!Array.isArray(body)) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol execute-batch response must be an array",
				);
			}
			return { results: body.map(decodeExecuteResponse) };
		},
		async createBranch(input) {
			const body = await readJson<CreateBranchResult>(
				await send("/lix/v1/branch/create", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: input.name,
						...(input.id ? { id: input.id } : {}),
						...(input.fromCommitId ? { fromCommitId: input.fromCommitId } : {}),
					}),
				}),
			);
			if (
				!isNonEmptyString(body.id) ||
				!isNonEmptyString(body.name) ||
				typeof body.hidden !== "boolean" ||
				!isNonEmptyString(body.commitId)
			) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol create branch response is invalid",
				);
			}
			return {
				id: body.id,
				name: body.name,
				hidden: body.hidden,
				commitId: body.commitId,
			};
		},
		async createCheckpoint() {
			const body = await readJson<{ commitId: string }>(
				await send("/lix/v1/checkpoint/create", { method: "POST" }),
			);
			if (!isNonEmptyString(body.commitId)) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol create checkpoint response is invalid",
				);
			}
			return { commitId: body.commitId };
		},
		async undo() {
			const body = await readJson<{
				branchId: string;
				targetCommitId: string;
				inverseCommitId: string;
			}>(await send("/lix/v1/undo", { method: "POST" }));
			if (
				!isNonEmptyString(body.branchId) ||
				!isNonEmptyString(body.targetCommitId) ||
				!isNonEmptyString(body.inverseCommitId)
			) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol undo response is invalid",
				);
			}
			currentBranchId = body.branchId;
			return body;
		},
		async redo() {
			const body = await readJson<{
				branchId: string;
				targetCommitId: string;
				replayCommitId: string;
			}>(await send("/lix/v1/redo", { method: "POST" }));
			if (
				!isNonEmptyString(body.branchId) ||
				!isNonEmptyString(body.targetCommitId) ||
				!isNonEmptyString(body.replayCommitId)
			) {
				throw createLixError(
					"upstream_error",
					"Lix Server Protocol redo response is invalid",
				);
			}
			currentBranchId = body.branchId;
			return body;
		},
		mergeBranchPreview() {
			unsupportedRemote("mergeBranchPreview");
		},
		mergeBranch() {
			unsupportedRemote("mergeBranch");
		},
		async close() {
			if (closed) return;
			closed = true;
			const response = await protocolFetch(
				"/lix/v1/session",
				new Request(new URL("/lix/v1/session", PROTOCOL_ORIGIN), {
					method: "DELETE",
					headers: { [LIX_SESSION_HEADER]: sessionId },
				}),
			);
			if (!response.ok && response.status !== 204) {
				await throwFromResponse(response);
			}
		},
	};
}

type HandshakeBody = {
	protocolVersion: unknown;
	activeBranchId: unknown;
	sessionId: unknown;
};

async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) await throwFromResponse(response);
	if (response.status === 204) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol response is missing a JSON body.",
		);
	}
	try {
		return (await response.json()) as T;
	} catch {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol response is not JSON.",
		);
	}
}

async function throwFromResponse(response: Response): Promise<never> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw createLixError(
			"upstream_error",
			`Remote Lix request failed with status ${response.status}`,
			{ status: response.status },
		);
	}
	const raw =
		body && typeof body === "object" && "error" in body
			? (body as { error: unknown }).error
			: undefined;
	const error =
		raw && typeof raw === "object"
			? (raw as Record<string, unknown>)
			: undefined;
	throw createLixError(
		typeof error?.code === "string" ? error.code : "upstream_error",
		typeof error?.message === "string"
			? error.message
			: `Remote Lix request failed with status ${response.status}`,
		{
			hint: typeof error?.hint === "string" ? error.hint : undefined,
			details: error?.details,
			status: response.status,
		},
	);
}

function encodeExecuteRequest(request: ExecuteRequest) {
	return {
		sql: request.sql,
		params: (request.params ?? []).map(toProtocolParam),
		...(request.options ? { options: request.options } : {}),
	};
}

function decodeExecuteResponse(value: unknown): ExecuteResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol execute result must be an object",
		);
	}
	const result = value as Record<string, unknown>;
	if (
		!Array.isArray(result.columns) ||
		!result.columns.every((column) => typeof column === "string")
	) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol execute result columns must be an array of strings",
		);
	}
	if (!Array.isArray(result.rows)) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol execute result rows must be an array",
		);
	}
	if (
		typeof result.rowsAffected !== "number" ||
		!Number.isSafeInteger(result.rowsAffected) ||
		result.rowsAffected < 0
	) {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol execute result rowsAffected must be a non-negative safe integer",
		);
	}
	return {
		columns: [...result.columns],
		rows: result.rows.map((row, rowIndex) => {
			if (!Array.isArray(row)) {
				throw createLixError(
					"upstream_error",
					`Lix Server Protocol execute result row ${rowIndex} must be an array`,
				);
			}
			return row.map(toMcpValue);
		}),
		rowsAffected: result.rowsAffected,
		notices: Array.isArray(result.notices) ? result.notices : [],
	};
}

function toProtocolParam(value: WireValue): Record<string, unknown> {
	switch (value.kind) {
		case "null":
			return { kind: "null", value: null };
		case "bool":
			return { kind: "bool", value: value.value };
		case "int":
			return { kind: "int", value: value.value };
		case "float":
			return { kind: "float", value: value.value };
		case "text":
			return { kind: "text", value: value.value };
		case "timestamp":
			return { kind: "timestamptz", value: value.value };
		case "json":
			return { kind: "jsonb", value: value.value };
		case "blob":
			return { kind: "blob", base64: value.base64 };
	}
}

function toMcpValue(value: unknown): WireValue {
	if (!value || typeof value !== "object") {
		throw createLixError(
			"upstream_error",
			"Lix Server Protocol wire value must be an object",
		);
	}
	const wire = value as Record<string, unknown>;
	switch (wire.kind) {
		case "null":
			return { kind: "null", value: null };
		case "bool":
			if (typeof wire.value !== "boolean") {
				throw createLixError("upstream_error", "bool wire value is invalid");
			}
			return { kind: "bool", value: wire.value };
		case "int":
			if (typeof wire.value !== "number" || !Number.isSafeInteger(wire.value)) {
				throw createLixError("upstream_error", "int wire value is invalid");
			}
			return { kind: "int", value: wire.value };
		case "float":
			if (typeof wire.value !== "number" || !Number.isFinite(wire.value)) {
				throw createLixError("upstream_error", "float wire value is invalid");
			}
			return { kind: "float", value: wire.value };
		case "text":
			if (typeof wire.value !== "string") {
				throw createLixError("upstream_error", "text wire value is invalid");
			}
			return { kind: "text", value: wire.value };
		case "timestamptz":
		case "timestamp":
			if (typeof wire.value !== "string") {
				throw createLixError(
					"upstream_error",
					"timestamp wire value is invalid",
				);
			}
			return { kind: "timestamp", value: wire.value };
		case "jsonb":
		case "json":
			return { kind: "json", value: wire.value };
		case "blob":
			if (typeof wire.base64 !== "string") {
				throw createLixError("upstream_error", "blob wire value is invalid");
			}
			return { kind: "blob", base64: wire.base64 };
		default:
			throw createLixError(
				"upstream_error",
				`unknown wire value kind: ${String(wire.kind)}`,
			);
	}
}

function unsupportedRemote(operation: string): never {
	throw createLixError(
		"LIX_UNSUPPORTED_REMOTE_OPERATION",
		`${operation} is not available over the Lix Server Protocol.`,
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
