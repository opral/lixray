import {
	type Branch,
	type BranchState,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	FileServiceError,
	type FileServiceErrorCode,
	type LixRuntimeClient,
	type FilesystemMutationOutcome,
	type FilesystemMutationRequest,
	type WorkspaceSummary,
} from "./file-service.ts";
import {
	fetchContainerWithRetry,
	type ContainerNamespace,
	type ContainerRetryDelay,
	type ContainerRetryObservation,
} from "../worker/container-retry.ts";

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
		const body = await this.containerJson<{
			branches?: unknown;
			currentBranchId?: unknown;
		}>(workspaceId, "/v1/branches", { method: "GET" });
		if (!Array.isArray(body.branches)) {
			throw new FileServiceError(
				"upstream_error",
				"Lix returned an invalid branch list.",
			);
		}
		if (typeof body.currentBranchId !== "string" || !body.currentBranchId) {
			throw new FileServiceError(
				"upstream_error",
				"Lix returned an invalid current branch.",
			);
		}
		const branches = body.branches.flatMap((value): Array<Branch> => {
			if (!value || typeof value !== "object") return [];
			const row = value as Record<string, unknown>;
			return typeof row.id === "string" &&
				typeof row.name === "string" &&
				typeof row.hidden === "boolean" &&
				typeof row.commitId === "string"
				? [
						{
							id: row.id,
							name: row.name,
							hidden: row.hidden,
							commitId: row.commitId,
						},
					]
				: [];
		});
		if (!branches.some((branch) => branch.id === body.currentBranchId)) {
			throw new FileServiceError(
				"upstream_error",
				"Lix current branch is missing from the branch list.",
			);
		}
		return { branches, currentBranchId: body.currentBranchId };
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		const response = await this.executeScript(workspaceId, request);
		const [result] = response.results;
		if (!result || response.results.length !== 1) {
			throw new FileServiceError(
				"upstream_error",
				"Lix returned an invalid single-statement result.",
			);
		}
		return result;
	}

	async executeScript(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteScriptResponse> {
		return this.containerJson<ExecuteScriptResponse>(
			workspaceId,
			"/v1/execute",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			},
		);
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
				error: errorDetails(caught),
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
