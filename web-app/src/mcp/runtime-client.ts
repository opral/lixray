import {
	type CreateBranchInput,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	createLixError,
	isLixError,
	type LixError,
	type LixRuntimeClient,
	type LixSummary,
} from "./lix-service.ts";
import {
	openProtocolSession,
	type ProtocolSession,
} from "./protocol-session.ts";

const TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";

interface McpUser {
	userId: string;
	token: string;
}

export interface WorkerLixRuntimeEnv {
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

type AuthorizeLix = (
	lixId: string,
	user: McpUser,
	env: WorkerLixRuntimeEnv,
) => Promise<Response | null>;

interface WorkerLixRuntimeClientOptions {
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	lixFetch?: (lixId: string, request: Request) => Promise<Response>;
	lixSummaries?: ReadonlyArray<LixSummary>;
}

interface LixSession {
	protocol: ProtocolSession;
	queue: Promise<void>;
}

export class WorkerLixRuntimeClient implements LixRuntimeClient {
	private readonly env: WorkerLixRuntimeEnv;
	private readonly user: McpUser;
	private readonly authorizeLix: AuthorizeLix;
	private readonly fetcher: typeof fetch;
	private readonly signal: AbortSignal | undefined;
	private readonly lixFetch:
		| ((lixId: string, request: Request) => Promise<Response>)
		| undefined;
	private readonly lixSummaries: ReadonlyArray<LixSummary> | undefined;
	private readonly sessions = new Map<string, Promise<LixSession>>();
	private closePromise: Promise<void> | undefined;
	private closed = false;

	constructor(
		env: WorkerLixRuntimeEnv,
		user: McpUser,
		authorizeLix: AuthorizeLix,
		options: WorkerLixRuntimeClientOptions = {},
	) {
		this.env = env;
		this.user = user;
		this.authorizeLix = authorizeLix;
		this.fetcher = options.fetcher ?? fetch;
		this.signal = options.signal;
		this.lixFetch = options.lixFetch;
		this.lixSummaries = options.lixSummaries;
	}

	async listLixes(): Promise<Array<LixSummary>> {
		if (this.lixSummaries) {
			return this.lixSummaries.map((lix) => ({
				...lix,
				namespace: { ...lix.namespace },
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
			"Content-Type": "application/json",
		};
		const lixesUrl = new URL("/rest/v1/rpc/list_accessible_lixes", supabaseUrl);

		const fetcher = this.fetcher;
		let lixesResponse: Response;
		try {
			lixesResponse = await fetcher(lixesUrl, {
				method: "POST",
				headers,
				body: "{}",
			});
		} catch (caught) {
			console.error("LixRay lix discovery fetch failed", {
				error: errorDetails(caught),
			});
			throw createLixError("upstream_error", "Lix discovery is unavailable.");
		}
		if (!lixesResponse.ok) {
			throw createLixError("upstream_error", "Lix discovery is unavailable.");
		}
		const lixes = asRows(await lixesResponse.json());

		return lixes.flatMap((row): Array<LixSummary> => {
			const id = stringField(row, "lix_id");
			const name = stringField(row, "lix_name");
			const slug = stringField(row, "lix_slug");
			const namespaceId = stringField(row, "namespace_id");
			const namespaceName = stringField(row, "namespace_name");
			const namespaceHandle = stringField(row, "namespace_handle");
			return id &&
				name &&
				slug &&
				namespaceId &&
				namespaceName &&
				namespaceHandle
				? [
						{
							id,
							name,
							slug,
							namespace: {
								id: namespaceId,
								name: namespaceName,
								handle: namespaceHandle,
							},
						},
					]
				: [];
		});
	}

	async activeBranchId(lixId: string, branchId?: string): Promise<string> {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				if (branchId) await this.ensureBranch(session, branchId);
				return session.protocol.activeBranchId();
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async switchBranch(
		lixId: string,
		branchId: string,
	): Promise<{ branchId: string }> {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, () =>
				session.protocol.switchBranch(branchId),
			);
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async execute(
		lixId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse>;
	async execute(
		lixId: string,
		branchId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse>;
	async execute(
		lixId: string,
		branchOrRequest: string | ExecuteRequest,
		maybeRequest?: ExecuteRequest,
	): Promise<ExecuteResponse> {
		const branchId =
			typeof branchOrRequest === "string"
				? branchOrRequest
				: await this.activeBranchId(lixId);
		const request =
			typeof branchOrRequest === "string" ? maybeRequest : branchOrRequest;
		if (!request)
			throw createLixError("upstream_error", "SQL request is missing.");
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.execute(request);
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async executeBatch(
		lixId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse>;
	async executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse>;
	async executeBatch(
		lixId: string,
		branchOrRequest: string | ExecuteBatchRequest,
		maybeRequest?: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse> {
		const branchId =
			typeof branchOrRequest === "string"
				? branchOrRequest
				: await this.activeBranchId(lixId);
		const request =
			typeof branchOrRequest === "string" ? maybeRequest : branchOrRequest;
		if (!request)
			throw createLixError("upstream_error", "SQL batch is missing.");
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.executeBatch(request);
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async createBranch(
		lixId: string,
		branchId: string,
		input: CreateBranchInput,
	) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.createBranch(input);
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async createCheckpoint(lixId: string, branchId: string) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.createCheckpoint();
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async undo(lixId: string, branchId: string) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.undo();
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async redo(lixId: string, branchId: string) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.redo();
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async mergeBranchPreview(
		lixId: string,
		branchId: string,
		sourceBranchId: string,
	) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.mergeBranchPreview(sourceBranchId);
			});
		} catch (caught) {
			throw asLixError(caught);
		}
	}

	async mergeBranch(lixId: string, branchId: string, sourceBranchId: string) {
		try {
			const session = await this.session(lixId);
			return await this.enqueueSession(session, async () => {
				await this.ensureBranch(session, branchId);
				return session.protocol.mergeBranch(sourceBranchId);
			});
		} catch (caught) {
			throw asLixError(caught);
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
						await session.protocol.close();
					} catch {
						// A failed open or operation has no live session to close.
					}
				}),
			);
		})();
		return this.closePromise;
	}

	private session(lixId: string): Promise<LixSession> {
		if (this.closed) {
			throw createLixError("upstream_error", "Lix client is closed.");
		}
		let pending = this.sessions.get(lixId);
		if (pending) return pending;
		pending = this.openSession(lixId).catch((error) => {
			this.sessions.delete(lixId);
			throw error;
		});
		this.sessions.set(lixId, pending);
		return pending;
	}

	private async openSession(lixId: string): Promise<LixSession> {
		return {
			protocol: await openProtocolSession((path, request) =>
				this.lixResponse(lixId, path, request),
			),
			queue: Promise.resolve(),
		};
	}

	private async enqueueSession<T>(
		session: LixSession,
		operation: () => Promise<T>,
	): Promise<T> {
		const result = session.queue.then(operation, operation);
		session.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async ensureBranch(
		session: LixSession,
		branchId: string,
	): Promise<void> {
		if (session.protocol.activeBranchId() !== branchId) {
			await session.protocol.switchBranch(branchId);
		}
	}

	private async lixResponse(
		lixId: string,
		path: string,
		request: Request,
	): Promise<Response> {
		const authorizationFailure = await this.authorizeLix(
			lixId,
			this.user,
			this.env,
		);
		if (authorizationFailure) return authorizationFailure;

		const url = new URL(request.url);
		url.pathname = path;
		const rewritten = new Request(url, request);
		const headers = new Headers(rewritten.headers);
		headers.delete("authorization");
		headers.delete(TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER);
		headers.set(TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER, this.user.userId);
		const template = new Request(rewritten, {
			headers,
			signal: this.signal ?? rewritten.signal,
		});
		if (this.lixFetch) {
			return this.lixFetch(lixId, template);
		}
		return new Response("Lix storage is not configured.\n", { status: 500 });
	}
}

function asLixError(caught: unknown): LixError {
	if (isLixError(caught) && !shouldRemapLixError(caught)) return caught;
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
	const details = error?.details;
	const message =
		typeof error?.message === "string"
			? error.message
			: caught instanceof Error
				? caught.message
				: "Lix request failed.";
	const hint = typeof error?.hint === "string" ? error.hint : undefined;
	const code =
		status === 403 || status === 404
			? "not_found"
			: rawCode?.startsWith("LIX_") && !transportError
				? (rawCode as `LIX_${string}`)
				: "upstream_error";
	return createLixError(code, message, { details, hint, status });
}

function shouldRemapLixError(error: LixError): boolean {
	const rawCode = error.code;
	const transportError =
		rawCode === "LIX_REMOTE_CANCELLED" ||
		rawCode === "LIX_REMOTE_PROTOCOL_ERROR" ||
		rawCode === "LIX_REMOTE_REQUEST_FAILED" ||
		rawCode === "LIX_REMOTE_UNAVAILABLE";
	return (
		(typeof error.status === "number" &&
			(error.status === 403 || error.status === 404)) ||
		transportError
	);
}

function requiredEnv(value: string | undefined, name: string): string {
	if (!value) {
		throw createLixError("upstream_error", `${name} is not configured.`);
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
