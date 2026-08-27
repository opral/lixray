import {
	openLix,
	type ExecuteResult as LixExecuteResult,
	type Lix,
	type SqlParam,
	Value,
} from "@lix-js/sdk";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth } from "~/components/auth-provider";
import { useRepository } from "~/components/repository-provider";
import { base64ToBytes, bytesToBase64 } from "./base64";

type WireValue =
	| { kind: "null"; value?: null }
	| { kind: "bool"; value: boolean }
	| { kind: "int"; value: number }
	| { kind: "float"; value: number }
	| { kind: "text"; value: string }
	| { kind: "timestamp"; value: string }
	| { kind: "blob"; base64: string }
	| { kind: "json"; value: unknown };

export interface Branch {
	id: string;
	name: string;
	hidden: boolean;
	commitId: string;
}

interface BranchesResponse {
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

interface ExecuteRequest {
	branchId: string;
	sql: string;
	params?: Array<WireValue>;
	options?: {
		originKey?: string;
	};
}

interface ExecuteBatchRequest {
	branchId: string;
	statements: Array<{
		sql: string;
		params?: Array<WireValue>;
	}>;
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
	const { activeRepository } = useRepository();
	const getTokenRef = useRef(getAccessToken);
	const clientRef = useRef<{ key: string; promise: Promise<Lix> } | null>(null);
	const queueRef = useRef(Promise.resolve());

	useEffect(() => {
		getTokenRef.current = getAccessToken;
	}, [getAccessToken]);

	const repositoryId = activeRepository?.repository.id ?? null;
	const repositoryKey = activeRepository
		? `${activeRepository.organization.handle}/${activeRepository.repository.slug}`
		: null;

	useEffect(() => {
		return () => {
			const client = clientRef.current;
			clientRef.current = null;
			if (client) void client.promise.then((lix) => lix.close());
		};
	}, [repositoryKey]);

	const getLix = useCallback(async (): Promise<Lix> => {
		if (!activeRepository || !repositoryKey) {
			throw new LixrayApiError(400, {
				error: { message: "No active repository is available" },
			});
		}
		if (clientRef.current?.key === repositoryKey) {
			return clientRef.current.promise;
		}
		const previous = clientRef.current;
		if (previous) void previous.promise.then((lix) => lix.close());
		const url = new URL(
			`/lix/${encodeURIComponent(activeRepository.repository.id)}`,
			globalThis.location.origin,
		);
		const promise = openLix({
			server: {
				url,
				mode: "remote",
				headers: async () => {
					const token = await getTokenRef.current();
					if (!token) {
						throw new LixrayApiError(401, {
							error: { message: "No Supabase access token is available" },
						});
					}
					return { Authorization: `Bearer ${token}` };
				},
			},
		});
		const client = { key: repositoryKey, promise };
		clientRef.current = client;
		void promise.catch(() => {
			if (clientRef.current === client) clientRef.current = null;
		});
		return promise;
	}, [activeRepository, repositoryKey]);

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

	return useMemo(
		() => ({
			repositoryId,
			activeBranchId: () => serialized((lix) => lix.activeBranchId()),
			switchBranch: (branchId: string) =>
				serialized((lix) => lix.switchBranch({ branchId })),
			listBranches: () =>
				serialized(async (lix) => {
					const result = await lix.execute(
						"SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id",
					);
					const currentBranchId = await lix.activeBranchId();
					return {
						branches: result.rows.map((row) => ({
							id: requiredRowString(row, "id"),
							name: requiredRowString(row, "name"),
							hidden: requiredRowBoolean(row, "hidden"),
							commitId: requiredRowString(row, "commit_id"),
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
			executeBatch: (body: ExecuteBatchRequest) =>
				serialized(async (lix) => {
					if ((await lix.activeBranchId()) !== body.branchId) {
						await lix.switchBranch({ branchId: body.branchId });
					}
					return {
						results: (
							await lix.executeBatch(
								body.statements.map((statement) => ({
									sql: statement.sql,
									params: (statement.params ?? []).map(toSqlParam),
								})),
								body.options,
							)
						).map(toWireResult),
					};
				}),
			executeActive: (body: Omit<ExecuteRequest, "branchId">) =>
				serialized(async (lix) => ({
					results: [
						toWireResult(
							await lix.execute(
								body.sql,
								(body.params ?? []).map(toSqlParam),
								body.options,
							),
						),
					],
				})),
			executeBatchActive: (body: Omit<ExecuteBatchRequest, "branchId">) =>
				serialized(async (lix) => ({
					results: (
						await lix.executeBatch(
							body.statements.map((statement) => ({
								sql: statement.sql,
								params: (statement.params ?? []).map(toSqlParam),
							})),
							body.options,
						)
					).map(toWireResult),
				})),
		}),
		[serialized, repositoryId],
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
		case "timestamp":
			return Value.timestamptz(value.value);
		case "json":
			return value.value as SqlParam;
		case "blob":
			return base64ToBytes(value.base64);
	}
}

function toWireResult(result: LixExecuteResult): ExecuteResponse {
	return {
		columns: result.columns.map((column) => column.name),
		rows: result.rows.map((row) =>
			result.columns.map((column) =>
				toWireValue(row[column.name], column.type),
			),
		),
		rowsAffected: result.rowsAffected,
		notices: result.notices,
	};
}

function toWireValue(
	value: unknown,
	kind: LixExecuteResult["columns"][number]["type"],
): WireValue {
	if (value === null) return { kind: "null", value: null };
	switch (kind) {
		case "null":
			return { kind: "null", value: null };
		case "boolean":
			if (typeof value === "boolean") return { kind: "bool", value };
			break;
		case "integer":
			if (typeof value === "number") return { kind: "int", value };
			break;
		case "real":
			if (typeof value === "number") return { kind: "float", value };
			break;
		case "text":
			if (typeof value === "string") return { kind: "text", value };
			break;
		case "timestamptz":
			if (typeof value === "string") return { kind: "timestamp", value };
			break;
		case "jsonb":
			return { kind: "json", value };
		case "blob":
			if (value instanceof Uint8Array) {
				return { kind: "blob", base64: bytesToBase64(value) };
			}
			break;
	}
	throw new Error(`Invalid ${kind} result value`);
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
		case "timestamp":
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
