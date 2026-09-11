import {
	openLix,
	type ExecuteResult as LixExecuteResult,
	type JsonValue,
	type Lix,
	type ResultArrayRow,
	type ResultColumnType,
	type SqlParam,
	Value,
} from "@lix-js/sdk";
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
import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";
import {
	provisionAccountAfterHandshake,
	type LixAccountProfile,
} from "./lix-account-provisioning.ts";

const TRUSTED_IDEMPOTENCY_PRINCIPAL_HEADER = "X-Lixray-Idempotency-Principal";

interface McpUser {
	userId: string;
	token: string;
	account?: LixAccountProfile;
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
	lix: Lix;
	queue: Promise<void>;
	/** The branch the Lix opened on, before any switch: its default. */
	defaultBranchId: string;
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

	hasOpenRuntime(lixId: string): boolean {
		return this.sessions.has(lixId);
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
				return session.lix.activeBranchId();
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
				session.lix.switchBranch({ branchId }),
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
				return encodeExecuteResult(
					await session.lix.execute(
						request.sql,
						(request.params ?? []).map(decodeWireParam),
						{ ...request.options, rowMode: "array" },
					),
				);
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
				const results = await session.lix.executeBatch(
					request.statements.map((statement) => ({
						sql: statement.sql,
						params: (statement.params ?? []).map(decodeWireParam),
					})),
					{ ...request.options, rowMode: "array" },
				);
				return { results: results.map(encodeExecuteResult) };
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
				return session.lix.createBranch(input);
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
				return session.lix.undo();
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
				return session.lix.redo();
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
				return session.lix.mergeBranchPreview({ sourceBranchId });
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
				return session.lix.mergeBranch({ sourceBranchId });
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
						await session.lix.close();
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
		const lix = await openLix({
			server: {
				url: `https://mcp.lixray.invalid/lix/${lixId}`,
				fetch: (input: RequestInfo | URL, init?: RequestInit) =>
					this.protocolFetch(lixId, input, init),
			},
		});
		return {
			lix,
			queue: Promise.resolve(),
			defaultBranchId: await lix.activeBranchId(),
		};
	}

	async defaultBranchId(lixId: string): Promise<string> {
		try {
			return (await this.session(lixId)).defaultBranchId;
		} catch (caught) {
			throw asLixError(caught);
		}
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
		if ((await session.lix.activeBranchId()) !== branchId) {
			await session.lix.switchBranch({ branchId });
		}
	}

	private async protocolFetch(
		lixId: string,
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(input, {
			...init,
			signal: init?.signal ?? this.signal,
		});
		const path = canonicalProtocolPath(new URL(request.url));
		if (path === null) return new Response("Not found\n", { status: 404 });
		return this.lixResponse(lixId, path, request);
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
		const lixFetch = this.lixFetch;
		if (lixFetch) {
			const response = await lixFetch(lixId, template);
			return provisionAccountAfterHandshake({
				lixId,
				protocolPath: path,
				response,
				account: this.user.account,
				lixFetch: (provisioningRequest) => lixFetch(lixId, provisioningRequest),
			});
		}
		return new Response("Lix storage is not configured.\n", { status: 500 });
	}
}

function canonicalProtocolPath(url: URL): string | null {
	const marker = "/lix/v1/";
	const markerIndex = url.pathname.indexOf(marker);
	if (markerIndex === -1) return null;
	return url.pathname.slice(markerIndex);
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
		case "timestamp":
			return Value.timestamptz(value.value);
		case "json":
			return Value.jsonb(value.value as JsonValue);
		case "blob":
			return Value.blob(base64ToBytes(value.base64));
	}
}

function encodeExecuteResult(
	result: LixExecuteResult<ResultArrayRow>,
): ExecuteResponse {
	return {
		columns: result.columns.map((column) => column.name),
		rows: result.rows.map((row) =>
			result.columns.map((column, index) =>
				encodeLixValue(column.type, row[index]),
			),
		),
		rowsAffected: result.rowsAffected,
		notices: result.notices.map((notice) => ({ ...notice })),
	};
}

function encodeLixValue(
	type: ResultColumnType,
	value: unknown,
): ExecuteResponse["rows"][number][number] {
	if (value === null) return { kind: "null", value: null };
	switch (type) {
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
		case "blob": {
			if (!(value instanceof Uint8Array)) {
				throw createLixError(
					"upstream_error",
					"Lix returned an invalid blob value.",
				);
			}
			return { kind: "blob", base64: bytesToBase64(value) };
		}
	}
	throw createLixError(
		"upstream_error",
		`Lix returned an invalid ${type} value.`,
	);
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
