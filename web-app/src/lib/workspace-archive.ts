import { zipSync } from "fflate";
import { base64ToBytes } from "./base64";
import type {
	BranchesResponse,
	ExecuteResponse,
	ExecuteScriptResponse,
	WireValue,
} from "./lixray-api";
import { workspaceApiPath } from "./lixray-api";

type AccessTokenGetter = () => Promise<string | null>;

export async function fetchWorkspaceFileCount(
	workspaceId: string,
	getAccessToken: AccessTokenGetter,
): Promise<number> {
	const branchId = await getCurrentBranchId(workspaceId, getAccessToken);
	const response = await workspaceRequest<ExecuteScriptResponse>(
		workspaceId,
		getAccessToken,
		"/execute",
		{
			method: "POST",
			body: JSON.stringify({
				branchId,
				sql: "SELECT COUNT(*) FROM lix_file",
				params: [],
			}),
		},
	);
	const result = singleResult(response);
	const value = result.rows[0]?.[0];
	return value?.kind === "int" ? value.value : 0;
}

export async function buildWorkspaceArchive(
	workspaceId: string,
	getAccessToken: AccessTokenGetter,
): Promise<Uint8Array<ArrayBuffer>> {
	const branchId = await getCurrentBranchId(workspaceId, getAccessToken);
	const response = await workspaceRequest<ExecuteScriptResponse>(
		workspaceId,
		getAccessToken,
		"/execute",
		{
			method: "POST",
			body: JSON.stringify({
				branchId,
				sql: "SELECT path, data FROM lix_file ORDER BY path",
				params: [],
			}),
		},
	);
	const result = singleResult(response);
	const entries: Record<string, Uint8Array> = {};
	for (const row of result.rows) {
		const path = asText(row[0]).replace(/^\/+/, "");
		const data = asBlob(row[1]);
		if (path) entries[path] = data;
	}
	return zipSync(entries);
}

function singleResult(response: ExecuteScriptResponse): ExecuteResponse {
	const [result] = response.results;
	if (!result || response.results.length !== 1) {
		throw new Error("Lix returned an invalid single-statement result");
	}
	return result;
}

async function getCurrentBranchId(
	workspaceId: string,
	getAccessToken: AccessTokenGetter,
): Promise<string> {
	const result = await workspaceRequest<BranchesResponse>(
		workspaceId,
		getAccessToken,
		"/branches",
	);
	const branch = result.branches.find(
		(candidate) => candidate.id === result.currentBranchId,
	);
	if (!branch)
		throw new Error("This workspace does not have a branch to archive.");
	return branch.id;
}

async function workspaceRequest<T>(
	workspaceId: string,
	getAccessToken: AccessTokenGetter,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const token = await getAccessToken();
	if (!token) throw new Error("Sign in to access this workspace.");
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	if (init.body) headers.set("content-type", "application/json");
	const response = await fetch(workspaceApiPath(workspaceId, path), {
		...init,
		headers,
	});
	const body: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			readErrorMessage(body) ?? `Request failed (${response.status})`,
		);
	}
	return body as T;
}

function asText(value: WireValue | undefined): string {
	if (!value || value.kind !== "text") {
		throw new Error("Workspace archive returned an invalid file path.");
	}
	return value.value;
}

function asBlob(value: WireValue | undefined): Uint8Array<ArrayBuffer> {
	if (!value || value.kind !== "blob") {
		throw new Error("Workspace archive returned invalid file data.");
	}
	return base64ToBytes(value.base64);
}

function readErrorMessage(body: unknown): string | null {
	if (!body || typeof body !== "object" || !("error" in body)) return null;
	const error = body.error;
	if (!error || typeof error !== "object" || !("message" in error)) return null;
	return typeof error.message === "string" ? error.message : null;
}
