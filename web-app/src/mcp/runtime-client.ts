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

interface McpUser {
	userId: string;
	token: string;
}

interface ContainerStub {
	startAndWaitForPorts?(options: {
		ports?: number | number[];
		startOptions: { envVars: Record<string, string> };
	}): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
}

type RetryDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

const TRANSIENT_CONTAINER_RETRY_DELAY_MS = 1_000;

export interface WorkerLixRuntimeEnv {
	SLATEDB_CONTAINER?: { getByName(name: string): ContainerStub };
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
	retryDelay?: RetryDelay;
	workspaceFetch?: (workspaceId: string, request: Request) => Promise<Response>;
	workspaceSummaries?: ReadonlyArray<WorkspaceSummary>;
}

export class WorkerLixRuntimeClient implements LixRuntimeClient {
	private readonly env: WorkerLixRuntimeEnv;
	private readonly user: McpUser;
	private readonly authorizeWorkspace: AuthorizeWorkspace;
	private readonly fetcher: typeof fetch;
	private readonly retryDelay: RetryDelay;
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
		this.retryDelay = options.retryDelay ?? delay;
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
		organizationsUrl.searchParams.set("select", "id,name");
		organizationsUrl.searchParams.set("order", "created_at.asc");
		const workspacesUrl = new URL("/rest/v1/workspaces", supabaseUrl);
		workspacesUrl.searchParams.set("select", "id,organization_id,name");
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
		const organizationNames = new Map(
			organizations.flatMap((row) => {
				const id = stringField(row, "id");
				const name = stringField(row, "name");
				return id && name ? [[id, name] as const] : [];
			}),
		);

		return workspaces.flatMap((row): Array<WorkspaceSummary> => {
			const id = stringField(row, "id");
			const name = stringField(row, "name");
			const organizationId = stringField(row, "organization_id");
			const organizationName = organizationId
				? organizationNames.get(organizationId)
				: undefined;
			return id && name && organizationId && organizationName
				? [
						{
							id,
							name,
							organization: { id: organizationId, name: organizationName },
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
		const createWorkspaceRequest = () =>
			new Request(`https://lixray-container.invalid${path}`, init);
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
		const container = containerNamespace.getByName(workspaceId);
		let retryCount = 0;
		for (;;) {
			assertNotAborted(init.signal);
			let response: Response;
			try {
				await container.startAndWaitForPorts?.({
					ports: 8080,
					startOptions: { envVars: containerEnv(this.env, workspaceId) },
				});
				response = await container.fetch(createWorkspaceRequest());
			} catch (caught) {
				if (!isTransientContainerError(caught)) {
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
				retryCount += 1;
				logTransientContainerRetry(workspaceId, path, retryCount, caught);
				await this.retryDelay(
					TRANSIENT_CONTAINER_RETRY_DELAY_MS,
					init.signal ?? undefined,
				);
				continue;
			}

			const body = await parseResponse(response);
			if (response.ok) return body as T;
			if (!isTransientContainerResponse(response, body)) {
				throw new FileServiceError(
					apiErrorCode(body) ?? "upstream_error",
					apiErrorMessage(body, response.status),
					apiErrorDetails(body, response.status),
				);
			}

			retryCount += 1;
			logTransientContainerRetry(workspaceId, path, retryCount, {
				status: response.status,
				message: apiErrorMessage(body, response.status),
			});
			await this.retryDelay(
				TRANSIENT_CONTAINER_RETRY_DELAY_MS,
				init.signal ?? undefined,
			);
		}
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

function isTransientContainerError(caught: unknown): boolean {
	const message = errorMessageWithCauses(caught).toLowerCase();
	if (message.includes("abort")) return false;
	return [
		"container is not running",
		"there is no container instance",
		"too many containers per second",
		"container crashed",
		"container exited before",
		"failed to start container",
		"failed to verify port",
		"network connection lost",
		"container suddenly disconnected",
		"error proxying request to container",
		"container is not listening",
		"connection refused",
		"connection reset",
		"fetch failed",
		"timed out",
		"timeout",
	].some((fragment) => message.includes(fragment));
}

function isTransientContainerResponse(
	response: Response,
	body: unknown,
): boolean {
	if ([429, 502, 503, 504].includes(response.status)) return true;
	return (
		response.status === 500 &&
		isTransientContainerError(apiErrorMessage(body, response.status))
	);
}

function errorMessageWithCauses(caught: unknown): string {
	const messages: Array<string> = [];
	const seen = new Set<unknown>();
	let current = caught;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(current.message);
			current = current.cause;
		} else if (
			typeof current === "string" ||
			typeof current === "number" ||
			typeof current === "boolean" ||
			typeof current === "bigint"
		) {
			messages.push(String(current));
			break;
		} else {
			messages.push("Unknown container error");
			break;
		}
	}
	return messages.join(" ");
}

function logTransientContainerRetry(
	workspaceId: string,
	path: string,
	retryCount: number,
	error: unknown,
): void {
	if (retryCount !== 1 && retryCount % 30 !== 0) return;
	console.warn("Transient LixRay container failure; retrying", {
		workspaceId,
		path,
		retryCount,
		retryDelayMs: TRANSIENT_CONTAINER_RETRY_DELAY_MS,
		error: errorDetails(error),
	});
}

function assertNotAborted(signal: AbortSignal | null | undefined): void {
	if (!signal?.aborted) return;
	throw new FileServiceError(
		"upstream_error",
		"Workspace storage request was cancelled.",
	);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				new FileServiceError(
					"upstream_error",
					"Workspace storage request was cancelled.",
				),
			);
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(
				new FileServiceError(
					"upstream_error",
					"Workspace storage request was cancelled.",
				),
			);
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
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
	return caught instanceof Error
		? { name: caught.name, message: caught.message, stack: caught.stack }
		: { value: String(caught) };
}
