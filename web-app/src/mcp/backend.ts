import {
	type Branch,
	type ExecuteRequest,
	type ExecuteResponse,
	FileServiceError,
	type FileServiceBackend,
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

export interface McpBackendEnv {
	SLATEDB_CONTAINER: { getByName(name: string): ContainerStub };
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
	env: McpBackendEnv,
) => Promise<Response | null>;

export class WorkerFileServiceBackend implements FileServiceBackend {
	private readonly env: McpBackendEnv;
	private readonly user: McpUser;
	private readonly authorizeWorkspace: AuthorizeWorkspace;
	private readonly fetcher: typeof fetch;

	constructor(
		env: McpBackendEnv,
		user: McpUser,
		authorizeWorkspace: AuthorizeWorkspace,
		fetcher: typeof fetch = fetch,
	) {
		this.env = env;
		this.user = user;
		this.authorizeWorkspace = authorizeWorkspace;
		this.fetcher = fetcher;
	}

	async listWorkspaces(): Promise<Array<WorkspaceSummary>> {
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
			console.error("Lixray workspace discovery fetch failed", {
				error: errorDetails(caught),
			});
			throw new FileServiceError(
				"backend_error",
				"Workspace discovery is unavailable.",
			);
		}
		if (!organizationsResponse.ok || !workspacesResponse.ok) {
			throw new FileServiceError(
				"backend_error",
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

	async listBranches(workspaceId: string): Promise<Array<Branch>> {
		const body = await this.containerJson<{ branches?: unknown }>(
			workspaceId,
			"/v1/branches",
			{ method: "GET" },
		);
		if (!Array.isArray(body.branches)) {
			throw new FileServiceError(
				"backend_error",
				"Lix returned an invalid branch list.",
			);
		}
		return body.branches.flatMap((value): Array<Branch> => {
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
	}

	async execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		return this.containerJson<ExecuteResponse>(workspaceId, "/v1/execute", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
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
				"backend_error",
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
				authorizationFailure.status === 403 ? "not_found" : "backend_error",
				message || "Workspace access denied.",
			);
		}
		const container = this.env.SLATEDB_CONTAINER.getByName(workspaceId);
		await container.startAndWaitForPorts?.({
			ports: 8080,
			startOptions: { envVars: containerEnv(this.env, workspaceId) },
		});
		const response = await container.fetch(
			new Request(`https://lixray-container.invalid${path}`, init),
		);
		const body = await parseResponse(response);
		if (!response.ok) {
			throw new FileServiceError(
				"backend_error",
				apiErrorMessage(body, response.status),
				{ status: response.status },
			);
		}
		return body as T;
	}
}

function containerEnv(
	env: McpBackendEnv,
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
	if (typeof body === "string" && body.trim()) return body.trim();
	return `Lix request failed with status ${status}.`;
}

function requiredEnv(value: string | undefined, name: string): string {
	if (!value) {
		throw new FileServiceError("backend_error", `${name} is not configured.`);
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
