import {
	openLix,
	type ExecuteResult as LixExecuteResult,
	type Lix,
	type SqlParam,
} from "@lix-js/sdk/remote";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth } from "~/components/auth-provider";
import { useWorkspace } from "~/components/workspace-provider";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { isDemoModeEnabled } from "./demo-client";
import { DEMO_AUTH_TOKEN } from "./demo-identity";
import type {
	FilesystemMutationOutcome,
	FilesystemMutationRequest,
} from "../mcp/file-service";

export type WireValue =
	| { kind: "null"; value?: null }
	| { kind: "bool"; value: boolean }
	| { kind: "int"; value: number }
	| { kind: "float"; value: number }
	| { kind: "text"; value: string }
	| { kind: "blob"; base64: string }
	| { kind: "json"; value: unknown };

export interface Branch {
	id: string;
	name: string;
	hidden: boolean;
	commitId: string;
}

export interface BranchesResponse {
	branches: Array<Branch>;
	currentBranchId: string;
}

export interface ExecuteResponse {
	columns: Array<string>;
	rows: Array<Array<WireValue>>;
	rowsAffected: number;
	notices: Array<unknown>;
}

export interface ExecuteScriptResponse {
	results: Array<ExecuteResponse>;
}

export interface ExecuteRequest {
	branchId: string;
	sql: string;
	params?: Array<WireValue>;
	options?: {
		originKey?: string;
	};
}

export class LixrayApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(formatApiError(status, body));
		this.name = "LixrayApiError";
		this.status = status;
		this.body = body;
	}
}

export function useLixrayApi() {
	const { getAccessToken } = useAuth();
	const { activeWorkspace } = useWorkspace();
	const getTokenRef = useRef(getAccessToken);
	const clientRef = useRef<{ key: string; promise: Promise<Lix> } | null>(null);
	const queueRef = useRef(Promise.resolve());

	useEffect(() => {
		getTokenRef.current = getAccessToken;
	}, [getAccessToken]);

	const workspaceId = activeWorkspace?.workspace.id ?? null;
	const workspaceKey = activeWorkspace
		? `${activeWorkspace.organization.handle}/${activeWorkspace.workspace.slug}`
		: null;

	useEffect(() => {
		return () => {
			const client = clientRef.current;
			clientRef.current = null;
			if (client) void client.promise.then((lix) => lix.close());
		};
	}, [workspaceKey]);

	const getLix = useCallback(async (): Promise<Lix> => {
		if (!activeWorkspace || !workspaceKey) {
			throw new LixrayApiError(400, {
				error: { message: "No active workspace is available" },
			});
		}
		if (clientRef.current?.key === workspaceKey) {
			return clientRef.current.promise;
		}
		const previous = clientRef.current;
		if (previous) void previous.promise.then((lix) => lix.close());
		const url = new URL(
			`/@${encodeURIComponent(activeWorkspace.organization.handle)}/${encodeURIComponent(activeWorkspace.workspace.slug)}`,
			globalThis.location.origin,
		);
		const promise = openLix({
			server: {
				url,
				mode: "remote",
				headers: async () => {
					const token = isDemoModeEnabled
						? DEMO_AUTH_TOKEN
						: await getTokenRef.current();
					if (!token) {
						throw new LixrayApiError(401, {
							error: { message: "No Supabase access token is available" },
						});
					}
					return { Authorization: `Bearer ${token}` };
				},
			},
		});
		const client = { key: workspaceKey, promise };
		clientRef.current = client;
		void promise.catch(() => {
			if (clientRef.current === client) clientRef.current = null;
		});
		return promise;
	}, [activeWorkspace, workspaceKey]);

	const serialized = useCallback(
		async <T>(operation: (lix: Lix) => Promise<T>): Promise<T> => {
			const result = queueRef.current.then(async () =>
				operation(await getLix()),
			);
			queueRef.current = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		[getLix],
	);

	const sidecarRequest = useCallback(
		async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const token = isDemoModeEnabled
				? DEMO_AUTH_TOKEN
				: await getTokenRef.current();
			if (!token) {
				throw new LixrayApiError(401, {
					error: { message: "No Supabase access token is available" },
				});
			}
			if (!workspaceId) {
				throw new LixrayApiError(400, {
					error: { message: "No active workspace is available" },
				});
			}

			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${token}`);
			if (init.body && !headers.has("content-type")) {
				headers.set("content-type", "application/json");
			}

			const { signal, cleanup } = requestSignal(init.signal);
			try {
				const response = await fetch(workspaceApiPath(workspaceId, path), {
					...init,
					headers,
					signal,
				});
				const body = await parseResponseBody(response);

				if (!response.ok) {
					throw new LixrayApiError(response.status, body);
				}

				return body as T;
			} finally {
				cleanup();
			}
		},
		[workspaceId],
	);

	return useMemo(
		() => ({
			workspaceId,
			listBranches: () =>
				serialized(async (lix) => {
					const result = await lix.execute(
						"SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id",
					);
					const currentBranchId = await lix.activeBranchId();
					return {
						branches: result.rows.map((row) => ({
							id: requiredRowString(row.toObject(), "id"),
							name: requiredRowString(row.toObject(), "name"),
							hidden: requiredRowBoolean(row.toObject(), "hidden"),
							commitId: requiredRowString(row.toObject(), "commit_id"),
						})),
						currentBranchId,
					} satisfies BranchesResponse;
				}),
			execute: (body: ExecuteRequest) =>
				serialized(async (lix) => {
					if ((await lix.activeBranchId()) !== body.branchId) {
						await lix.switchBranch({ branchId: body.branchId });
					}
					return {
						results: [
							toWireResult(
								await lix.execute(
									body.sql,
									(body.params ?? []).map(toSqlParam),
									body.options,
								),
							),
						],
					};
				}),
			mutateFilesystem: async (body: FilesystemMutationRequest) => {
				const response = await sidecarRequest<{
					outcome: FilesystemMutationOutcome;
				}>("/filesystem/mutate", {
					method: "POST",
					body: JSON.stringify(body),
				});
				return response.outcome;
			},
		}),
		[serialized, sidecarRequest, workspaceId],
	);
}

function toSqlParam(value: WireValue): SqlParam {
	switch (value.kind) {
		case "null":
			return null;
		case "bool":
		case "int":
		case "float":
		case "text":
			return value.value;
		case "json":
			return value.value as SqlParam;
		case "blob":
			return base64ToBytes(value.base64);
	}
}

function toWireResult(result: LixExecuteResult): ExecuteResponse {
	return {
		columns: result.columns,
		rows: result.rows.map((row) =>
			result.columns.map((column) => {
				const value = row.value(column);
				const js = value.toJS();
				switch (value.kind) {
					case "null":
						return { kind: "null", value: null };
					case "boolean":
						return { kind: "bool", value: Boolean(js) };
					case "integer":
						return { kind: "int", value: Number(js) };
					case "real":
						return { kind: "float", value: Number(js) };
					case "text":
						return { kind: "text", value: String(js) };
					case "blob":
						return { kind: "blob", base64: bytesToBase64(value.asBytes()!) };
					case "json":
						return { kind: "json", value: js };
				}
			}),
		),
		rowsAffected: result.rowsAffected,
		notices: result.notices,
	};
}

function requiredRowString(
	row: Record<string, unknown>,
	column: string,
): string {
	const value = row[column];
	if (typeof value !== "string")
		throw new Error(`Expected text column ${column}`);
	return value;
}

function requiredRowBoolean(
	row: Record<string, unknown>,
	column: string,
): boolean {
	const value = row[column];
	if (typeof value !== "boolean") {
		throw new Error(`Expected boolean column ${column}`);
	}
	return value;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workspaceApiPath(
	workspaceId: string,
	endpoint: string,
): string {
	if (!UUID_PATTERN.test(workspaceId)) {
		throw new Error("A valid workspace UUID is required");
	}
	if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
		throw new Error("Workspace API endpoints must be absolute paths");
	}
	return `/v1/workspaces/${encodeURIComponent(workspaceId)}${endpoint}`;
}

function requestSignal(parentSignal: AbortSignal | null | undefined): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error("LixRay request timed out."));
	}, 45_000);
	const abortFromParent = () => controller.abort(parentSignal?.reason);

	if (parentSignal) {
		if (parentSignal.aborted) {
			abortFromParent();
		} else {
			parentSignal.addEventListener("abort", abortFromParent, { once: true });
		}
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function parseResponseBody(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return response.json();
	}
	return response.text();
}

function formatApiError(status: number, body: unknown): string {
	if (
		body &&
		typeof body === "object" &&
		"error" in body &&
		body.error &&
		typeof body.error === "object" &&
		"message" in body.error &&
		typeof body.error.message === "string"
	) {
		return body.error.message;
	}

	if (typeof body === "string" && body.trim()) {
		return body.trim();
	}

	return `LixRay request failed with status ${status}`;
}

export function formatWireValue(value: WireValue): string {
	switch (value.kind) {
		case "null":
			return "null";
		case "bool":
		case "int":
		case "float":
			return String(value.value);
		case "text":
			return value.value;
		case "blob":
			return `[blob ${value.base64.length} base64 chars]`;
		case "json":
			return JSON.stringify(value.value);
		default: {
			const exhaustive: never = value;
			return JSON.stringify(exhaustive);
		}
	}
}

export function parseParamsJson(value: string): Array<WireValue> {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Params must be a JSON array of Lix wire values.");
	}
	return parsed as Array<WireValue>;
}
