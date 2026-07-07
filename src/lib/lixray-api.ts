import { useAuth } from "@clerk/tanstack-react-start";
import { useCallback, useMemo } from "react";

export type WireValue =
	| { kind: "null" }
	| { kind: "boolean"; value: boolean }
	| { kind: "integer"; value: number }
	| { kind: "real"; value: number }
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
}

export interface ExecuteResponse {
	columns: Array<string>;
	rows: Array<Array<WireValue>>;
	rowsAffected: number;
	notices: Array<unknown>;
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
	const { getToken } = useAuth();

	const request = useCallback(
		async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const token = await getToken();
			if (!token) {
				throw new LixrayApiError(401, {
					error: { message: "No Clerk session token is available" },
				});
			}

			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${token}`);
			if (init.body && !headers.has("content-type")) {
				headers.set("content-type", "application/json");
			}

			const response = await fetch(path, {
				...init,
				headers,
			});
			const body = await parseResponseBody(response);

			if (!response.ok) {
				throw new LixrayApiError(response.status, body);
			}

			return body as T;
		},
		[getToken],
	);

	return useMemo(
		() => ({
			listBranches: () => request<BranchesResponse>("/v1/branches"),
			execute: (body: ExecuteRequest) =>
				request<ExecuteResponse>("/v1/execute", {
					method: "POST",
					body: JSON.stringify(body),
				}),
		}),
		[request],
	);
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

	return `Lixray request failed with status ${status}`;
}

export function formatWireValue(value: WireValue): string {
	switch (value.kind) {
		case "null":
			return "null";
		case "boolean":
		case "integer":
		case "real":
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
	const parsed = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Params must be a JSON array of Lix wire values.");
	}
	return parsed as Array<WireValue>;
}
