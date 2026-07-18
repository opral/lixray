import {
	openLix,
	type ExecuteResult as LixExecuteResult,
	type JsonValue,
	type Lix,
	type SqlParam,
	Value,
} from "@lix-js/sdk/remote";
import {
	type Branch,
	type BranchState,
	type ExecuteRequest,
	type ExecuteResponse,
	FileServiceError,
	type FileServiceErrorCode,
	type LixRuntimeClient,
	type FilesystemMutationOutcome,
	type FilesystemMutationRequest,
	type WorkspaceSummary,
} from "./file-service.ts";
import {
	containerErrorDetails,
	fetchContainerWithRetry,
	type ContainerNamespace,
	type ContainerRetryDelay,
	type ContainerRetryObservation,
} from "../worker/container-retry.ts";
import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";
import { handleRemoteLixProtocolRequest } from "../worker/remote-lix-protocol.ts";

interface McpUser {
	userId: string;
	token: string;
}

export interface WorkerLixRuntimeEnv {
	SLATEDB_CONTAINER?: ContainerNamespace;
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_STORAGE?: string;
	SLATEDB_CACHE_DIR?: string;
	SLATEDB_CACHE_MAX_BYTES?: string;
	SLATEDB_BLOCK_CACHE_BYTES?: string;
	SLATEDB_METADATA_CACHE_BYTES?: string;
}

type AuthorizeWorkspace = (
	workspaceId: string,
	user: McpUser,
	env: WorkerLixRuntimeEnv,
) => Promise<Response | null>;

export interface WorkerLixRuntimeClientOptions {
	fetcher?: typeof fetch;
	retryDelay?: ContainerRetryDelay;
	retryRandom?: () => number;
	signal?: AbortSignal;
	workspaceFetch?: (workspaceId: string, request: Request) => Promise<Response>;
	workspaceSummaries?: ReadonlyArray<WorkspaceSummary>;
}

interface WorkspaceLixSession {
	lix: Lix;
	defaultBranchId: string;
	activeBranchId: string;
	queue: Promise<void>;
}

export class WorkerLixRuntimeClient implements LixRuntimeClient {
	private readonly env: WorkerLixRuntimeEnv;
	private readonly user: McpUser;
	private readonly authorizeWorkspace: AuthorizeWorkspace;
	private readonly fetcher: typeof fetch;
	private readonly retryDelay: ContainerRetryDelay | undefined;
	private readonly retryRandom: (() => number) | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly workspaceFetch:
		| ((workspaceId: string, request: Request) => Promise<Response>)
		| undefined;
	private readonly workspaceSummaries:
		| ReadonlyArray<WorkspaceSummary>
		| undefined;
	private readonly sessions = new Map<string, Promise<WorkspaceLixSession>>();
	private closePromise: Promise<void> | undefined;
	private closed = false;

	constructor(
		env: WorkerLixRuntimeEnv,
		user: McpUser,
		authorizeWorkspace: AuthorizeWorkspace,
		options: WorkerLixRuntimeClientOptions = {},
	) {
		this.env = env;
		this.user = user;
		this.authorizeWorkspace = authorizeWorkspace;
		this.fetcher = options.fetcher ?? fetch;
		this.retryDelay = options.retryDelay;
		this.retryRandom = options.retryRandom;
		this.signal = options.signal;
		this.workspaceFetch = options.workspaceFetch;
		this.workspaceSummaries = options.workspaceSummaries;
	}

	async listWorkspaces(): Promise<Array<WorkspaceSummary>> {
		if (this.workspaceSummaries) {
			return this.workspaceSummaries.map((workspace) => ({
				...workspace,
				organization: { ...workspace.organization },
			}));
		}
		const supabaseUrl = requiredEnv(this.env.SUPABASE_URL, "SUPABASE_URL");
		const publishableKey = requiredEnv(
			this.env.SUPABASE_PUBLISHABLE_KEY,
			"SUPABASE_PUBLISHABLE_KEY",
		);
		const headers = {
			apikey: publishableKey,
			Authorization: `Bearer ${this.user.token}`,
			Accept: "application/json",
		};
		const organizationsUrl = new URL("/rest/v1/organizations", supabaseUrl);
		organizationsUrl.searchParams.set("select", "id,name,handle");
		organizationsUrl.searchParams.set("order", "created_at.asc");
		const workspacesUrl = new URL("/rest/v1/workspaces", supabaseUrl);
		workspacesUrl.searchParams.set("select", "id,organization_id,name,slug");
		workspacesUrl.searchParams.set("order", "created_at.asc");

		const fetcher = this.fetcher;
		let organizationsResponse: Response;
		let workspacesResponse: Response;
		try {
			[organizationsResponse, workspacesResponse] = await Promise.all([
				fetcher(organizationsUrl, { headers }),
				fetcher(workspacesUrl, { headers }),
			]);
		} catch (caught) {
			console.error("LixRay workspace discovery fetch failed", {
				error: errorDetails(caught),
			});
			throw new FileServiceError(
				"upstream_error",
				"Workspace discovery is unavailable.",
			);
		}
		if (!organizationsResponse.ok || !workspacesResponse.ok) {
			throw new FileServiceError(
				"upstream_error",
				"Workspace discovery is unavailable.",
			);
		}
		const organizations = asRows(await organizationsResponse.json());
		const workspaces = asRows(await workspacesResponse.json());
		const organizationsById = new Map(
			organizations.flatMap((row) => {
				const id = stringField(row, "id");
				const name = stringField(row, "name");
				const handle = stringField(row, "handle");
				return id && name && handle ? [[id, { name, handle }] as const] : [];
			}),
		);

		return workspaces.flatMap((row): Array<WorkspaceSummary> => {
			const id = stringField(row, "id");
			const name = stringField(row, "name");
			const slug = stringField(row, "slug");
			const organizationId = stringField(row, "organization_id");
			const organization = organizationId
				? organizationsById.get(organizationId)
				: undefined;
			return id && name && slug && organizationId && organization
				? [
						{
							id,
							name,
							slug,
							organization: { id: organizationId, ...organization },
						},
					]
				: [];
		});
	}

	async listBranches(workspaceId: string): Promise<BranchState> {
		try {
			const session = await this.session(workspaceId);
			return await this.enqueueSession(session, async () => {
				await this.selectBranch(session, session.defaultBranchId);
				const result = await session.lix.execute(
					"SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id",
				);
				const branches = result.rows.map((row): Branch => {
					const id = row.get("id");
					const name = row.get("name");
					const hidden = row.get("hidden");
					const commitId = row.get("commit_id");
					if (
						typeof id !== "string" ||
						typeof name !== "string" ||
						typeof hidden !== "boolean" ||
						typeof commitId !== "string"
					) {
						throw new FileServiceError(
							"upstream_error",
							"Lix returned an invalid branch list.",
						);
					}
					return { id, name, hidden, commitId };
				});
				if (!branches.some((branch) => branch.id === session.defaultBranchId)) {
					throw new FileServiceError(
						"upstream_error",
						"Lix current branch is missing from the branch list.",
					);
				}
				return {
					branches,
					currentBranchId: session.defaultBranchId,
				};
			});
		} catch (caught) {
			throw asFileServiceError(caught);
		}
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		try {
			const session = await this.session(workspaceId);
			return await this.enqueueSession(session, async () => {
				await this.selectBranch(session, request.branchId);
				return encodeExecuteResult(
					await session.lix.execute(
						request.sql,
						(request.params ?? []).map(decodeWireParam),
						request.options,
					),
				);
			});
		} catch (caught) {
			throw asFileServiceError(caught);
		}
	}

	async close(): Promise<void> {
		this.closePromise ??= (async () => {
			this.closed = true;
			const sessions = [...this.sessions.values()];
			this.sessions.clear();
			await Promise.all(
				sessions.map(async (pending) => {
					try {
						const session = await pending;
						await session.queue;
						await session.lix.close();
					} catch {
						// A failed open or operation has no live session to close.
					}
				}),
			);
		})();
		return this.closePromise;
	}

	async mutate(
		workspaceId: string,
		request: FilesystemMutationRequest,
	): Promise<FilesystemMutationOutcome> {
		const body = await this.containerJson<{ outcome?: unknown }>(
			workspaceId,
			"/v1/filesystem/mutate",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			},
		);
		if (
			body.outcome !== "applied" &&
			body.outcome !== "conflict" &&
			body.outcome !== "already_exists"
		) {
			throw new FileServiceError(
				"upstream_error",
				"Lix returned an invalid filesystem mutation outcome.",
			);
		}
		return body.outcome;
	}

	private session(workspaceId: string): Promise<WorkspaceLixSession> {
		if (this.closed) {
			throw new FileServiceError("upstream_error", "Lix client is closed.");
		}
		let pending = this.sessions.get(workspaceId);
		if (pending) return pending;
		pending = this.openSession(workspaceId).catch((error) => {
			this.sessions.delete(workspaceId);
			throw error;
		});
		this.sessions.set(workspaceId, pending);
		return pending;
	}

	private async openSession(workspaceId: string): Promise<WorkspaceLixSession> {
		const lix = await openLix({
			server: {
				mode: "remote",
				url: `https://mcp.lixray.invalid/workspaces/${encodeURIComponent(workspaceId)}`,
				fetch: (input, init) => this.protocolFetch(workspaceId, input, init),
			},
		});
		const defaultBranchId = await lix.activeBranchId();
		return {
			lix,
			defaultBranchId,
			activeBranchId: defaultBranchId,
			queue: Promise.resolve(),
		};
	}

	private async enqueueSession<T>(
		session: WorkspaceLixSession,
		operation: () => Promise<T>,
	): Promise<T> {
		const result = session.queue.then(operation, operation);
		session.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async selectBranch(
		session: WorkspaceLixSession,
		branchId: string,
	): Promise<void> {
		if (session.activeBranchId === branchId) return;
		await session.lix.switchBranch({ branchId });
		session.activeBranchId = branchId;
	}

	private async protocolFetch(
		workspaceId: string,
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(input, {
			...init,
			signal: init?.signal ?? this.signal,
		});
		const endpoint = remoteProtocolEndpoint(new URL(request.url));
		if (endpoint === null) return new Response("Not found\n", { status: 404 });
		return handleRemoteLixProtocolRequest(
			request,
			endpoint,
			(path, protocolRequest) =>
				this.workspaceResponse(workspaceId, path, protocolRequest),
		);
	}

	private async workspaceResponse(
		workspaceId: string,
		path: string,
		request: Request,
	): Promise<Response> {
		const authorizationFailure = await this.authorizeWorkspace(
			workspaceId,
			this.user,
			this.env,
		);
		if (authorizationFailure) return authorizationFailure;

		const url = new URL(request.url);
		url.pathname = `/v1${path}`;
		const rewritten = new Request(url, request);
		const headers = new Headers(rewritten.headers);
		headers.delete("authorization");
		const template = new Request(rewritten, { headers });
		if (this.workspaceFetch) {
			return this.workspaceFetch(workspaceId, template);
		}

		const containerNamespace = this.env.SLATEDB_CONTAINER;
		if (!containerNamespace) {
			return new Response("Workspace storage is not configured.\n", {
				status: 500,
			});
		}
		try {
			return await fetchContainerWithRetry({
				namespace: containerNamespace,
				workspaceId,
				operation: `${request.method} /v1${path}`,
				envVars: containerEnv(this.env, workspaceId),
				createRequest: () => template.clone() as unknown as Request,
				requestReplay: workspaceRequestReplay(request.method, path),
				signal: request.signal,
				retryDelay: this.retryDelay,
				retryRandom: this.retryRandom,
				onRetry: logTransientContainerRetry,
			});
		} catch (caught) {
			if (request.signal.aborted) {
				return Response.json(
					{
						error: {
							code: "LIX_REMOTE_CANCELLED",
							message: "Workspace storage request was cancelled.",
						},
					},
					{ status: 499 },
				);
			}
			console.error("LixRay container request failed", {
				workspaceId,
				path,
				error: containerErrorDetails(caught),
			});
			throw caught;
		}
	}

	private async containerJson<T>(
		workspaceId: string,
		path: string,
		init: RequestInit,
	): Promise<T> {
		const authorizationFailure = await this.authorizeWorkspace(
			workspaceId,
			this.user,
			this.env,
		);
		if (authorizationFailure) {
			const message = (await authorizationFailure.text()).trim();
			throw new FileServiceError(
				authorizationFailure.status === 403 ? "not_found" : "upstream_error",
				message || "Workspace access denied.",
			);
		}
		const signal = init.signal ?? this.signal;
		const createWorkspaceRequest = () =>
			new Request(`https://lixray-container.invalid${path}`, {
				...init,
				signal,
			});
		if (this.workspaceFetch) {
			return this.responseJson<T>(
				await this.workspaceFetch(workspaceId, createWorkspaceRequest()),
			);
		}

		const containerNamespace = this.env.SLATEDB_CONTAINER;
		if (!containerNamespace) {
			throw new FileServiceError(
				"upstream_error",
				"Workspace storage is not configured.",
			);
		}
		let response: Response;
		try {
			response = await fetchContainerWithRetry({
				namespace: containerNamespace,
				workspaceId,
				operation: path,
				envVars: containerEnv(this.env, workspaceId),
				createRequest: createWorkspaceRequest,
				requestReplay: ["GET", "HEAD"].includes(
					(init.method ?? "GET").toUpperCase(),
				)
					? "safe"
					: "unsafe",
				signal: signal ?? undefined,
				retryDelay: this.retryDelay,
				retryRandom: this.retryRandom,
				onRetry: logTransientContainerRetry,
			});
		} catch (caught) {
			if (signal?.aborted) {
				throw new FileServiceError(
					"upstream_error",
					"Workspace storage request was cancelled.",
				);
			}
			console.error("LixRay container request failed", {
				workspaceId,
				path,
				error: containerErrorDetails(caught),
			});
			throw new FileServiceError(
				"upstream_error",
				"Workspace storage request failed.",
			);
		}

		const body = await parseResponse(response);
		if (response.ok) return body as T;
		throw new FileServiceError(
			apiErrorCode(body) ?? "upstream_error",
			apiErrorMessage(body, response.status),
			apiErrorDetails(body, response.status),
		);
	}

	private async responseJson<T>(response: Response): Promise<T> {
		const body = await parseResponse(response);
		if (!response.ok) {
			throw new FileServiceError(
				apiErrorCode(body) ?? "upstream_error",
				apiErrorMessage(body, response.status),
				apiErrorDetails(body, response.status),
			);
		}
		return body as T;
	}
}

function remoteProtocolEndpoint(url: URL): string | null {
	const marker = "/.lix/v1/";
	const markerIndex = url.pathname.indexOf(marker);
	if (markerIndex === -1) return null;
	return url.pathname.slice(markerIndex + marker.length);
}

function workspaceRequestReplay(
	method: string,
	path: string,
): "safe" | "unsafe" {
	if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return "safe";
	return path === "/observe" || path === "/observe/multiplex"
		? "safe"
		: "unsafe";
}

function decodeWireParam(
	value: NonNullable<ExecuteRequest["params"]>[number],
): SqlParam {
	switch (value.kind) {
		case "null":
			return Value.null();
		case "bool":
			return Value.boolean(value.value);
		case "int":
			return Value.integer(value.value);
		case "float":
			return Value.real(value.value);
		case "text":
			return Value.text(value.value);
		case "json":
			return Value.json(value.value as JsonValue);
		case "blob":
			return Value.blob(base64ToBytes(value.base64));
	}
}

function encodeExecuteResult(result: LixExecuteResult): ExecuteResponse {
	return {
		columns: [...result.columns],
		rows: result.rows.map((row) =>
			result.columns.map((column) => encodeLixValue(row.value(column))),
		),
		rowsAffected: result.rowsAffected,
		notices: result.notices.map((notice) => ({ ...notice })),
	};
}

type LixResultValue = ReturnType<LixExecuteResult["rows"][number]["value"]>;

function encodeLixValue(
	value: LixResultValue,
): ExecuteResponse["rows"][number][number] {
	const jsValue = value.toJS();
	switch (value.kind) {
		case "null":
			return { kind: "null", value: null };
		case "boolean":
			return { kind: "bool", value: jsValue as boolean };
		case "integer":
			return { kind: "int", value: jsValue as number };
		case "real":
			return { kind: "float", value: jsValue as number };
		case "text":
			return { kind: "text", value: jsValue as string };
		case "json":
			return { kind: "json", value: jsValue };
		case "blob": {
			const bytes = value.asBytes();
			if (!bytes) {
				throw new FileServiceError(
					"upstream_error",
					"Lix returned an invalid blob value.",
				);
			}
			return { kind: "blob", base64: bytesToBase64(bytes) };
		}
	}
}

function asFileServiceError(caught: unknown): FileServiceError {
	if (caught instanceof FileServiceError) return caught;
	const error =
		caught && typeof caught === "object"
			? (caught as Record<string, unknown>)
			: undefined;
	const status = typeof error?.status === "number" ? error.status : undefined;
	const rawCode = typeof error?.code === "string" ? error.code : undefined;
	const transportError =
		rawCode === "LIX_REMOTE_CANCELLED" ||
		rawCode === "LIX_REMOTE_PROTOCOL_ERROR" ||
		rawCode === "LIX_REMOTE_REQUEST_FAILED" ||
		rawCode === "LIX_REMOTE_UNAVAILABLE";
	const details =
		error?.details &&
		typeof error.details === "object" &&
		!Array.isArray(error.details)
			? { ...(error.details as Record<string, unknown>) }
			: {};
	if (status !== undefined) details.status = status;
	if (typeof error?.hint === "string") details.hint = error.hint;
	const code: FileServiceErrorCode =
		status === 403 || status === 404
			? "not_found"
			: rawCode?.startsWith("LIX_") && !transportError
				? (rawCode as `LIX_${string}`)
				: "upstream_error";
	return new FileServiceError(
		code,
		caught instanceof Error ? caught.message : "Lix request failed.",
		Object.keys(details).length === 0 ? undefined : details,
	);
}

function containerEnv(
	env: WorkerLixRuntimeEnv,
	workspaceId: string,
): Record<string, string> {
	const vars: Record<string, string> = { SLATEDB_PATH: workspaceId };
	for (const name of [
		"R2_ENDPOINT",
		"R2_BUCKET",
		"R2_ACCESS_KEY_ID",
		"R2_SECRET_ACCESS_KEY",
		"R2_REGION",
		"SLATEDB_STORAGE",
		"SLATEDB_CACHE_DIR",
		"SLATEDB_CACHE_MAX_BYTES",
		"SLATEDB_BLOCK_CACHE_BYTES",
		"SLATEDB_METADATA_CACHE_BYTES",
	] as const) {
		const value = env[name];
		if (value !== undefined) vars[name] = value;
	}
	return vars;
}

async function parseResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.includes("application/json")
		? response.json()
		: response.text();
}

function apiErrorMessage(body: unknown, status: number): string {
	const error = apiErrorBody(body);
	if (typeof error?.message === "string") return error.message;
	if (typeof body === "string" && body.trim()) return body.trim();
	return `Lix request failed with status ${status}.`;
}

function apiErrorCode(body: unknown): FileServiceErrorCode | undefined {
	const code = apiErrorBody(body)?.code;
	return typeof code === "string" && code.startsWith("LIX_")
		? (code as `LIX_${string}`)
		: undefined;
}

function apiErrorDetails(
	body: unknown,
	status: number,
): Record<string, unknown> {
	const error = apiErrorBody(body);
	const details =
		error?.details &&
		typeof error.details === "object" &&
		!Array.isArray(error.details)
			? (error.details as Record<string, unknown>)
			: {};
	return {
		...details,
		status,
		...(typeof error?.hint === "string" ? { hint: error.hint } : {}),
	};
}

function apiErrorBody(body: unknown): Record<string, unknown> | undefined {
	if (!body || typeof body !== "object" || !("error" in body)) return undefined;
	const error = body.error;
	return error && typeof error === "object"
		? (error as Record<string, unknown>)
		: undefined;
}

function logTransientContainerRetry(
	observation: ContainerRetryObservation,
): void {
	if (observation.retryCount !== 1 && observation.retryCount % 30 !== 0) return;
	console.warn("Transient LixRay container failure; retrying", {
		workspaceId: observation.workspaceId,
		path: observation.operation,
		retryCount: observation.retryCount,
		retryDelayMs: observation.retryDelayMs,
		error: errorDetails(observation.error),
	});
}

function requiredEnv(value: string | undefined, name: string): string {
	if (!value) {
		throw new FileServiceError("upstream_error", `${name} is not configured.`);
	}
	return value;
}

function asRows(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value)
		? value.filter(
				(row): row is Record<string, unknown> =>
					Boolean(row) && typeof row === "object",
			)
		: [];
}

function stringField(
	row: Record<string, unknown>,
	name: string,
): string | null {
	return typeof row[name] === "string" ? row[name] : null;
}

function errorDetails(caught: unknown): Record<string, unknown> {
	if (caught instanceof Error) {
		return { name: caught.name, message: caught.message, stack: caught.stack };
	}
	return caught && typeof caught === "object"
		? { ...(caught as Record<string, unknown>) }
		: { value: String(caught) };
}
