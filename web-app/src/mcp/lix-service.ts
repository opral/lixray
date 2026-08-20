import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";

const LIX_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALIFIED_LIX_REF_PATTERN =
	/^@([a-z0-9](?:-?[a-z0-9]){0,38})\/([a-z0-9](?:-?[a-z0-9]){0,99})$/;
const DEFAULT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const DEVELOPMENT_CONTEXT_SIGNING_KEY = "lixray-development-context-key";

export type WireValue =
	| { kind: "null"; value?: null }
	| { kind: "bool"; value: boolean }
	| { kind: "int"; value: number }
	| { kind: "float"; value: number }
	| { kind: "text"; value: string }
	| { kind: "timestamp"; value: string }
	| { kind: "blob"; base64: string }
	| { kind: "json"; value: unknown };

export interface ExecuteOptions {
	originKey?: string;
}

export interface ExecuteRequest {
	sql: string;
	params?: Array<WireValue>;
	options?: ExecuteOptions;
}

export interface ExecuteResponse {
	columns: Array<string>;
	rows: Array<Array<WireValue>>;
	rowsAffected: number;
	notices: Array<unknown>;
}

export interface ExecuteBatchRequest {
	statements: Array<{
		sql: string;
		params?: Array<WireValue>;
	}>;
	options?: ExecuteOptions;
}

export interface ExecuteScriptResponse {
	results: Array<ExecuteResponse>;
}

export interface LixSummary {
	id: string;
	name: string;
	slug: string;
	namespace: { id: string; name: string; handle: string };
}

export interface LixContext {
	readonly lixId: string;
	readonly branchId: string;
}

export interface OpenedLixContext {
	context: string;
	contextExpiresAt: string;
	lixId: string;
	lixRef: string;
	branchId: string;
	commitId: string;
}

export interface CreateBranchInput {
	id?: string;
	name: string;
	fromCommitId?: string;
}

export interface CreateBranchResult {
	id: string;
	name: string;
	hidden: boolean;
	commitId: string;
}

/**
 * The canonical structured error shape shared by Lix, LixRay, and MCP.
 * Transport metadata such as HTTP status stays outside `details` so the
 * Lix-provided diagnostic payload is never rewritten at an adapter boundary.
 */
export type LixError = Error & {
	code?: string;
	hint?: string;
	details?: unknown;
	status?: number;
};

export function createLixError(
	code: string,
	message: string,
	options: {
		details?: unknown;
		hint?: string;
		status?: number;
	} = {},
): LixError {
	const error = new Error(message) as LixError;
	error.name = "LixError";
	error.code = code;
	error.hint = options.hint;
	error.details = options.details;
	error.status = options.status;
	return error;
}

export function isLixError(value: unknown): value is LixError {
	return (
		value instanceof Error &&
		(typeof (value as LixError).code === "string" ||
			typeof (value as LixError).hint === "string" ||
			"details" in value)
	);
}

/**
 * The runtime facade mirrors the stateful JavaScript SDK while making the
 * branch explicit at the boundary. Every operation that can observe or
 * mutate Lix state receives a branch id and the implementation pins the
 * underlying SDK handle to it before executing.
 */
export interface BindSessionInput {
	lixId: string;
	branchId: string;
	accountId: string;
	organizationId?: string;
}

export interface LixRuntimeClient {
	listLixes(): Promise<Array<LixSummary>>;
	hasOpenRuntime(lixId: string): boolean;
	bindSession(input: BindSessionInput): void;
	activeBranchId(lixId: string, branchId?: string): Promise<string>;
	switchBranch(lixId: string, branchId: string): Promise<{ branchId: string }>;
	execute(
		lixId: string,
		branchId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse>;
	executeBatch(
		lixId: string,
		branchId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse>;
	createBranch(
		lixId: string,
		branchId: string,
		input: CreateBranchInput,
	): Promise<CreateBranchResult>;
	createCheckpoint(
		lixId: string,
		branchId: string,
	): Promise<{ commitId: string }>;
	undo(
		lixId: string,
		branchId: string,
	): Promise<{
		branchId: string;
		targetCommitId: string;
		inverseCommitId: string;
	}>;
	redo(
		lixId: string,
		branchId: string,
	): Promise<{
		branchId: string;
		targetCommitId: string;
		replayCommitId: string;
	}>;
	mergeBranchPreview(
		lixId: string,
		branchId: string,
		sourceBranchId: string,
	): Promise<Record<string, unknown>>;
	mergeBranch(
		lixId: string,
		branchId: string,
		sourceBranchId: string,
	): Promise<Record<string, unknown>>;
}

interface ContextClaims {
	v: 1;
	userId: string;
	clientId: string;
	lixId: string;
	branchId: string;
	expiresAt: number;
}

interface LixServiceOptions {
	contextSigningKey?: string;
	principal?: { userId: string; clientId: string };
	contextTtlMs?: number;
}

/**
 * Stateless application context. It is deliberately separate from the MCP
 * transport session: hosts may create a fresh MCP server for every request,
 * while this signed value carries the selected Lix and branch forward.
 */
export class LixService {
	private readonly client: LixRuntimeClient;
	private readonly signingKey: string;
	private readonly principal: { userId: string; clientId: string };
	private readonly contextTtlMs: number;
	private readonly cryptoKeyPromise: Promise<CryptoKey>;

	constructor(client: LixRuntimeClient, options: LixServiceOptions = {}) {
		this.client = client;
		this.signingKey =
			options.contextSigningKey?.trim() || DEVELOPMENT_CONTEXT_SIGNING_KEY;
		this.principal = options.principal ?? {
			userId: "anonymous",
			clientId: "local",
		};
		this.contextTtlMs = options.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
		this.cryptoKeyPromise = crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(this.signingKey),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
	}

	async listLixes(): Promise<Array<LixSummary>> {
		return this.client.listLixes();
	}

	async resolveLixRef(lixRef: string): Promise<string> {
		return (await this.resolveLixSummary(lixRef)).id;
	}

	private async resolveLixSummary(lixRef: string): Promise<LixSummary> {
		const normalizedUuid = LIX_UUID_PATTERN.test(lixRef)
			? lixRef.toLowerCase()
			: undefined;

		const qualified = QUALIFIED_LIX_REF_PATTERN.exec(lixRef);
		const lixes = await this.listLixes();
		const matches = normalizedUuid
			? lixes.filter((lix) => lix.id.toLowerCase() === normalizedUuid)
			: qualified
				? lixes.filter(
						(lix) =>
							lix.namespace.handle === qualified[1] &&
							lix.slug === qualified[2],
					)
				: lixes.filter((lix) => lix.slug === lixRef);

		if (matches.length === 1) return matches[0];
		if (matches.length === 0)
			throw createLixError("not_found", "Lix not found.");
		throw createLixError(
			"ambiguous_lix_ref",
			"Lix slug is ambiguous; use an exact Lix UUID or @namespace/slug.",
		);
	}

	async openLix(lixRef: string, branchId?: string): Promise<OpenedLixContext> {
		const repository = await this.resolveLixSummary(lixRef);
		const lixId = repository.id;
		const selectedBranchId = branchId
			? (await this.client.switchBranch(lixId, branchId)).branchId
			: await this.client.activeBranchId(lixId);
		const issuedContext = await this.issueContext(lixId, selectedBranchId);
		const commitId = await this.commitId(lixId, selectedBranchId);
		// Bind the OAuth / principal account on every successful signed-context
		// mint. Cache-admit / protocol-root open is not a product bind.
		this.client.bindSession({
			lixId,
			branchId: selectedBranchId,
			accountId: this.principal.userId,
			organizationId: repository.namespace.id,
		});
		return {
			context: issuedContext.token,
			contextExpiresAt: new Date(issuedContext.expiresAt).toISOString(),
			lixId,
			lixRef: `@${repository.namespace.handle}/${repository.slug}`,
			branchId: selectedBranchId,
			commitId,
		};
	}

	async activeBranchId(contextToken: string): Promise<{
		context: string;
		branchId: string;
		commitId: string;
	}> {
		const context = await this.readContext(contextToken);
		const branchId = await this.client.activeBranchId(
			context.lixId,
			context.branchId,
		);
		return {
			context: contextToken,
			branchId,
			commitId: await this.commitId(context.lixId, branchId),
		};
	}

	async switchBranch(contextToken: string, branchId: string) {
		const context = await this.readContext(contextToken);
		const selected = await this.client.switchBranch(context.lixId, branchId);
		const nextContext = await this.issueContext(
			context.lixId,
			selected.branchId,
		);
		return {
			context: nextContext.token,
			branchId: selected.branchId,
			commitId: await this.commitId(context.lixId, selected.branchId),
		};
	}

	async execute(contextToken: string, request: ExecuteRequest) {
		const context = await this.readContext(contextToken);
		return {
			context: contextToken,
			result: await this.client.execute(
				context.lixId,
				context.branchId,
				request,
			),
		};
	}

	async executeBatch(contextToken: string, request: ExecuteBatchRequest) {
		const context = await this.readContext(contextToken);
		return {
			context: contextToken,
			results: (
				await this.client.executeBatch(context.lixId, context.branchId, request)
			).results,
		};
	}

	async createBranch(contextToken: string, input: CreateBranchInput) {
		const context = await this.readContext(contextToken);
		const branch = await this.client.createBranch(
			context.lixId,
			context.branchId,
			input,
		);
		return {
			context: contextToken,
			branch: {
				id: branch.id,
				name: branch.name,
				hidden: branch.hidden,
				commitId: branch.commitId,
			},
		};
	}

	async createCheckpoint(contextToken: string) {
		const context = await this.readContext(contextToken);
		const checkpoint = await this.client.createCheckpoint(
			context.lixId,
			context.branchId,
		);
		return { context: contextToken, commitId: checkpoint.commitId };
	}

	async restore(contextToken: string, commitId: string) {
		const context = await this.readContext(contextToken);
		const response = await this.client.execute(
			context.lixId,
			context.branchId,
			{
				sql: "SELECT lix_restore($1)",
				params: [{ kind: "text", value: commitId }],
			},
		);
		const restoredCommitId = response.rows[0]?.[0];
		if (
			!restoredCommitId ||
			restoredCommitId.kind !== "text" ||
			restoredCommitId.value !== commitId
		) {
			throw createLixError(
				"upstream_error",
				"Lix did not confirm the requested restore commit id.",
			);
		}
		return {
			context: contextToken,
			branchId: context.branchId,
			commitId: restoredCommitId.value,
		};
	}

	async undo(contextToken: string) {
		const context = await this.readContext(contextToken);
		const receipt = await this.client.undo(context.lixId, context.branchId);
		return { context: contextToken, ...receipt };
	}

	async redo(contextToken: string) {
		const context = await this.readContext(contextToken);
		const receipt = await this.client.redo(context.lixId, context.branchId);
		return { context: contextToken, ...receipt };
	}

	async mergeBranchPreview(contextToken: string, sourceBranchId: string) {
		const context = await this.readContext(contextToken);
		return {
			context: contextToken,
			...(await this.client.mergeBranchPreview(
				context.lixId,
				context.branchId,
				sourceBranchId,
			)),
		};
	}

	async mergeBranch(contextToken: string, sourceBranchId: string) {
		const context = await this.readContext(contextToken);
		return {
			context: contextToken,
			...(await this.client.mergeBranch(
				context.lixId,
				context.branchId,
				sourceBranchId,
			)),
		};
	}

	async contextLixId(contextToken: string): Promise<string> {
		return (await this.readContext(contextToken)).lixId;
	}

	private async commitId(lixId: string, branchId: string): Promise<string> {
		const response = await this.client.execute(lixId, branchId, {
			sql: "SELECT lix_active_branch_commit_id() AS commit_id",
		});
		const value = response.rows[0]?.[0];
		if (!value || value.kind !== "text") {
			throw createLixError(
				"upstream_error",
				"Lix did not return an active commit id.",
			);
		}
		return value.value;
	}

	private async issueContext(
		lixId: string,
		branchId: string,
	): Promise<{ token: string; expiresAt: number }> {
		const expiresAt = Date.now() + this.contextTtlMs;
		const claims: ContextClaims = {
			v: 1,
			userId: this.principal.userId,
			clientId: this.principal.clientId,
			lixId,
			branchId,
			expiresAt,
		};
		const encodedClaims = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify(claims)),
		);
		const signature = await crypto.subtle.sign(
			"HMAC",
			await this.cryptoKeyPromise,
			new TextEncoder().encode(encodedClaims),
		);
		return {
			token: `${encodedClaims}.${encodeBase64Url(new Uint8Array(signature))}`,
			expiresAt,
		};
	}

	private async readContext(token: string): Promise<LixContext> {
		if (typeof token !== "string") {
			throw createLixError("invalid_context", "context must be a string.");
		}
		const parts = token.split(".");
		if (parts.length !== 2) {
			throw createLixError("invalid_context", "context is invalid.");
		}
		const [encodedClaims, encodedSignature] = parts;
		let claims: ContextClaims;
		let signature: Uint8Array<ArrayBuffer>;
		try {
			const parsed: unknown = JSON.parse(decodeBase64Url(encodedClaims));
			if (!parsed || typeof parsed !== "object")
				throw new Error("invalid claims");
			claims = parsed as ContextClaims;
			signature = base64ToBytes(toBase64(encodedSignature));
			if (encodeBase64Url(signature) !== encodedSignature) {
				throw new Error("non-canonical signature");
			}
		} catch {
			throw createLixError("invalid_context", "context is invalid.");
		}
		const valid = await crypto.subtle.verify(
			"HMAC",
			await this.cryptoKeyPromise,
			signature,
			new TextEncoder().encode(encodedClaims),
		);
		if (
			!valid ||
			claims.v !== 1 ||
			claims.userId !== this.principal.userId ||
			claims.clientId !== this.principal.clientId ||
			typeof claims.lixId !== "string" ||
			typeof claims.branchId !== "string"
		) {
			throw createLixError("invalid_context", "context is invalid.");
		}
		if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= Date.now()) {
			throw createLixError("context_expired", "The Lix context has expired.", {
				hint: "Call open_lix again for this Lix and branch, then retry the SQL operation.",
				details: { lix_id: claims.lixId, branch_id: claims.branchId },
			});
		}
		return { lixId: claims.lixId, branchId: claims.branchId };
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
	return new TextDecoder().decode(base64ToBytes(toBase64(value)));
}

function toBase64(value: string): string {
	return `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
}
