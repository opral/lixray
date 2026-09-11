import { entityRoutePath } from "../lib/entity-url.ts";
import {
	CHANGED_FILES_SQL,
	READ_FILES_SQL,
	encodeFileContent,
	escapeLike,
	fileWriteStatements,
	normalizeFilePath,
	type FileContent,
	type FileWrite,
} from "./file-tools.ts";
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
	name: string;
	url: string;
	files: Array<{ id: string; path: string; url: string }>;
	branchId: string;
	commitId: string;
	fileCount: number;
	directoryCount: number;
	filePaths: Array<string>;
	filePathsComplete: boolean;
	empty: boolean;
}

export const OPEN_LIX_INVENTORY_SQL =
	"SELECT (SELECT COUNT(*) FROM lix_file) AS file_count, (SELECT COUNT(*) FROM lix_directory) AS directory_count";
export const OPEN_LIX_FILE_MANIFEST_LIMIT = 50;
export const OPEN_LIX_FILE_MANIFEST_SQL = `SELECT id, path FROM lix_file ORDER BY path LIMIT ${OPEN_LIX_FILE_MANIFEST_LIMIT}`;

export const CONTEXT_REOPEN_HINT =
	"Call open_lix again. Use structuredContent.context; do not copy TEXT.";

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
export interface LixRuntimeClient {
	listLixes(): Promise<Array<LixSummary>>;
	hasOpenRuntime(lixId: string): boolean;
	activeBranchId(lixId: string, branchId?: string): Promise<string>;
	/** The branch a Lix opens on; URLs name any other branch explicitly. */
	defaultBranchId(lixId: string): Promise<string>;
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
		if (matches.length === 0) {
			throw createLixError("not_found", "Lix not found.", {
				hint: "Call list_lixes and pass an exact @handle/slug or Lix UUID to open_lix.",
			});
		}
		throw createLixError(
			"ambiguous_lix_ref",
			"Lix slug is ambiguous; use an exact Lix UUID or @namespace/slug.",
			{
				hint: "Call list_lixes and pass the exact Lix UUID or @namespace/slug.",
			},
		);
	}

	async openLix(
		lixRef: string,
		branchId?: string,
		origin = "https://lixray.com",
	): Promise<OpenedLixContext> {
		const repository = await this.resolveLixSummary(lixRef);
		const lixId = repository.id;
		const selectedBranchId = branchId
			? (await this.client.switchBranch(lixId, branchId)).branchId
			: await this.client.activeBranchId(lixId);
		const issuedContext = await this.issueContext(lixId, selectedBranchId);
		const commitId = await this.commitId(lixId, selectedBranchId);
		const inventory = await this.fileInventory(lixId, selectedBranchId);
		const defaultBranchId = await this.client.defaultBranchId(lixId);
		const branch = { id: selectedBranchId, defaultId: defaultBranchId };
		return {
			context: issuedContext.token,
			contextExpiresAt: new Date(issuedContext.expiresAt).toISOString(),
			lixId,
			lixRef: `@${repository.namespace.handle}/${repository.slug}`,
			name: repository.name,
			url: canonicalEntityUrl(repository, branch, origin),
			files: inventory.files.map((file) => ({
				...file,
				url: canonicalEntityUrl(repository, branch, origin, {
					kind: "file",
					...file,
				}),
			})),
			branchId: selectedBranchId,
			commitId,
			fileCount: inventory.fileCount,
			directoryCount: inventory.directoryCount,
			filePaths: inventory.filePaths,
			filePathsComplete: inventory.filePathsComplete,
			empty: inventory.fileCount === 0 && inventory.directoryCount === 0,
		};
	}

	async getEntityUrls(
		contextToken: string,
		entities: Array<{ kind: "file" | "directory"; id?: string; path?: string }>,
		origin = "https://lixray.com",
	): Promise<{
		context: string;
		entities: Array<{
			kind: "file" | "directory";
			id: string | null;
			path: string;
			url: string;
		}>;
	}> {
		const context = await this.readContext(contextToken);
		if (
			!Array.isArray(entities) ||
			entities.length === 0 ||
			entities.length > 50 ||
			entities.some(
				(entity) =>
					!entity ||
					(entity.kind !== "file" && entity.kind !== "directory") ||
					(entity.id === undefined) === (entity.path === undefined) ||
					(entity.id !== undefined &&
						(typeof entity.id !== "string" ||
							!ENTITY_UUID_PATTERN.test(entity.id))) ||
					(entity.path !== undefined &&
						(typeof entity.path !== "string" ||
							!canonicalLookupPath(entity.path, entity.kind))),
			)
		)
			throw createLixError(
				"invalid_request",
				"Provide 1–50 entities, each with a kind and exactly one UUID or canonical absolute path.",
			);
		const repository = await this.resolveLixSummary(context.lixId);
		const found = new Map<string, Array<{ id: string; path: string }>>();
		for (const kind of ["file", "directory"] as const) {
			const selectors = entities.filter(
				(entity) =>
					entity.kind === kind &&
					!(kind === "directory" && entity.path === "/"),
			);
			if (!selectors.length) continue;
			const response = await this.client.execute(
				context.lixId,
				context.branchId,
				{
					sql: `SELECT id, path FROM ${kind === "file" ? "lix_file" : "lix_directory"} WHERE ${selectors.map((entity, index) => `${entity.id !== undefined ? "id" : "path"} = $${index + 1}`).join(" OR ")} LIMIT 50`,
					params: selectors.map((entity) => ({
						kind: "text",
						value:
							entity.id?.toLowerCase() ??
							canonicalLookupPath(entity.path!, kind)!,
					})),
				},
			);
			const idColumn = response.columns.indexOf("id");
			const pathColumn = response.columns.indexOf("path");
			found.set(
				kind,
				response.rows.map((row) => {
					const id = row[idColumn];
					const path = row[pathColumn];
					if (
						id?.kind !== "text" ||
						!ENTITY_UUID_PATTERN.test(id.value) ||
						path?.kind !== "text"
					)
						throw createLixError(
							"upstream_error",
							"Lix returned an invalid entity.",
						);
					return { id: id.value, path: path.value };
				}),
			);
		}
		const branch = {
			id: context.branchId,
			defaultId: await this.client.defaultBranchId(context.lixId),
		};
		return {
			context: contextToken,
			entities: entities.map((selector) => {
				if (selector.kind === "directory" && selector.path === "/")
					return {
						kind: selector.kind,
						id: null,
						path: "/",
						url: canonicalEntityUrl(repository, branch, origin),
					};
				const entity = found
					.get(selector.kind)
					?.find((candidate) =>
						selector.id !== undefined
							? candidate.id.toLowerCase() === selector.id.toLowerCase()
							: candidate.path ===
								canonicalLookupPath(selector.path!, selector.kind),
					);
				if (!entity)
					throw createLixError(
						"not_found",
						"Entity not found in the selected Lix branch.",
					);
				return {
					...entity,
					id:
						selector.kind === "directory" && entity.path === "/"
							? null
							: entity.id,
					kind: selector.kind,
					url: canonicalEntityUrl(repository, branch, origin, {
						...entity,
						kind: selector.kind,
					}),
				};
			}),
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

	/** Files by path prefix and name, with ids and canonical URLs. */
	async listFiles(
		contextToken: string,
		filter: { directory?: string; name?: string },
		origin = "https://lixray.com",
	): Promise<{
		context: string;
		commitId: string;
		files: Array<{ id: string; path: string; url: string }>;
		truncated: boolean;
	}> {
		const context = await this.readContext(contextToken);
		const conditions: string[] = [];
		const params: WireValue[] = [];
		if (filter.directory) {
			const directory = filter.directory.trim().replace(/\/+$/, "");
			if (!directory.startsWith("/"))
				throw createLixError(
					"invalid_request",
					"directory must be an absolute path such as /gtm.",
				);
			params.push({ kind: "text", value: `${escapeLike(directory)}/%` });
			conditions.push(`path LIKE $${params.length} ESCAPE '\\'`);
		}
		if (filter.name) {
			params.push({
				kind: "text",
				value: `%${escapeLike(filter.name.trim().toLowerCase())}%`,
			});
			conditions.push(`LOWER(name) LIKE $${params.length} ESCAPE '\\'`);
		}
		const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
		const [response, commitId, url] = await Promise.all([
			this.client.execute(context.lixId, context.branchId, {
				sql: `SELECT id, path FROM lix_file${where} ORDER BY path LIMIT ${LIST_FILES_LIMIT + 1}`,
				params,
			}),
			this.commitId(context.lixId, context.branchId),
			this.entityUrl(context, origin),
		]);
		const rows = readIdPathRows(response);
		return {
			context: contextToken,
			commitId,
			files: rows
				.slice(0, LIST_FILES_LIMIT)
				.map((file) => ({ ...file, url: url("file", file) })),
			truncated: rows.length > LIST_FILES_LIMIT,
		};
	}

	/** Files by absolute path: bytes, metadata, and the commit the read reflects. */
	async readFiles(
		contextToken: string,
		paths: readonly string[],
		origin = "https://lixray.com",
	): Promise<ReadFilesResult> {
		const context = await this.readContext(contextToken);
		const normalized = paths.map(normalizeFilePathOrThrow);
		const [files, commitId, url] = await Promise.all([
			this.fileRows(context, normalized),
			this.commitId(context.lixId, context.branchId),
			this.entityUrl(context, origin),
		]);
		const found = new Set(files.map((file) => file.path));
		return {
			context: contextToken,
			commitId,
			files: files.map((file) => ({ ...file, url: url("file", file) })),
			missing: normalized.filter((path) => !found.has(path)),
		};
	}

	/**
	 * Creates or updates files in one commit. With `lastSeenCommitId`, a
	 * target file that changed since that commit refuses the whole write and
	 * the error carries the current commit and contents; unrelated changes
	 * never block. The check and the write are two steps, so a write landing
	 * between them on the same file is not caught; the window is small.
	 */
	async writeFiles(
		contextToken: string,
		input: {
			files: readonly FileWrite[];
			lastSeenCommitId?: string;
			checkpoint?: boolean;
			originKey: string;
		},
		origin = "https://lixray.com",
	): Promise<{
		context: string;
		commitId: string;
		files: Array<{ id: string; path: string; url: string }>;
		checkpointCommitId?: string;
	}> {
		const context = await this.readContext(contextToken);
		const files = input.files.map((file) => ({
			...file,
			path: normalizeFilePathOrThrow(file.path),
		}));
		const paths = files.map((file) => file.path);
		if (new Set(paths).size !== paths.length)
			throw createLixError("invalid_request", "Each path may appear once.");
		const metadataOnly = files
			.filter((file) => file.content === undefined)
			.map((file) => file.path);
		if (
			files.some(
				(file) =>
					file.content === undefined && file.lixcol_metadata === undefined,
			)
		)
			throw createLixError(
				"invalid_request",
				"A file needs content, lixcol_metadata, or both.",
			);
		if (input.lastSeenCommitId !== undefined) {
			const head = await this.commitId(context.lixId, context.branchId);
			if (head !== input.lastSeenCommitId) {
				const changed = await this.changedSince(
					context,
					input.lastSeenCommitId,
					head,
					paths,
				);
				if (changed.length > 0) {
					const current = await this.fileRows(context, changed);
					throw createLixError(
						"conflict",
						`${changed.length === 1 ? "A file" : `${changed.length} files`} changed since last_seen_commit_id: ${changed.join(", ")}.`,
						{
							hint: "Merge your edit into the current contents in details.files, then write again with last_seen_commit_id = details.current_commit_id.",
							details: {
								current_commit_id: head,
								files: current.map((file) => ({
									path: file.path,
									content: file.content,
									lixcol_metadata: file.lixcol_metadata,
								})),
							},
						},
					);
				}
			}
		}
		if (metadataOnly.length > 0) {
			const existing = new Set(
				(await this.fileRows(context, metadataOnly)).map((file) => file.path),
			);
			const missing = metadataOnly.filter((path) => !existing.has(path));
			if (missing.length > 0)
				throw createLixError(
					"not_found",
					`No file to update metadata on: ${missing.join(", ")}. Give it content to create it.`,
				);
		}
		const statements = fileWriteStatements(files);
		const batch = await this.client.executeBatch(
			context.lixId,
			context.branchId,
			{
				statements: statements.map(({ sql, params }) => ({ sql, params })),
				options: { originKey: input.originKey },
			},
		);
		const written: Array<{ id: string; path: string }> = [];
		statements.forEach((statement, index) => {
			if (!statement.path) return;
			const row = readIdPathRows(batch.results[index] ?? EMPTY_RESPONSE)[0];
			if (!row)
				throw createLixError(
					"upstream_error",
					`Lix did not return the written file ${statement.path}.`,
				);
			written.push(row);
		});
		const checkpointCommitId = input.checkpoint
			? (await this.createCheckpoint(contextToken)).commitId
			: undefined;
		const [commitId, url] = await Promise.all([
			this.commitId(context.lixId, context.branchId),
			this.entityUrl(context, origin),
		]);
		return {
			context: contextToken,
			commitId,
			files: written.map((file) => ({ ...file, url: url("file", file) })),
			...(checkpointCommitId ? { checkpointCommitId } : {}),
		};
	}

	/** The target paths that a diff between two commits touched. */
	private async changedSince(
		context: LixContext,
		fromCommitId: string,
		toCommitId: string,
		paths: readonly string[],
	): Promise<string[]> {
		let response: ExecuteResponse;
		try {
			response = await this.client.execute(context.lixId, context.branchId, {
				sql: CHANGED_FILES_SQL(paths.length),
				params: [
					{ kind: "text", value: fromCommitId },
					{ kind: "text", value: toCommitId },
					...paths.map((path): WireValue => ({ kind: "text", value: path })),
				],
			});
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			throw createLixError(
				"invalid_request",
				`last_seen_commit_id could not be compared with the branch head: ${message}`,
				{
					hint: "Pass the commit_id a read_files or write_files result returned.",
				},
			);
		}
		const from = response.columns.indexOf("from_path");
		const to = response.columns.indexOf("to_path");
		const wanted = new Set(paths);
		const changed = new Set<string>();
		for (const row of response.rows) {
			for (const value of [row[from], row[to]]) {
				if (value?.kind === "text" && wanted.has(value.value))
					changed.add(value.value);
			}
		}
		return paths.filter((path) => changed.has(path));
	}

	private async fileRows(
		context: LixContext,
		paths: readonly string[],
	): Promise<Array<ReadFile>> {
		if (paths.length === 0) return [];
		const response = await this.client.execute(
			context.lixId,
			context.branchId,
			{
				sql: READ_FILES_SQL(paths.length),
				params: paths.map((path): WireValue => ({ kind: "text", value: path })),
			},
		);
		const columns = {
			id: response.columns.indexOf("id"),
			path: response.columns.indexOf("path"),
			content: response.columns.indexOf("content"),
			metadata: response.columns.indexOf("lixcol_metadata"),
		};
		const byPath = new Map<string, ReadFile>();
		for (const row of response.rows) {
			const id = row[columns.id];
			const path = row[columns.path];
			const content = row[columns.content];
			const metadata = row[columns.metadata];
			if (
				id?.kind !== "text" ||
				path?.kind !== "text" ||
				content?.kind !== "blob"
			)
				throw createLixError(
					"upstream_error",
					"Lix returned an invalid file row.",
				);
			byPath.set(path.value, {
				id: id.value,
				path: path.value,
				...encodeFileContent(base64ToBytes(content.base64)),
				lixcol_metadata:
					metadata?.kind === "json" &&
					metadata.value !== null &&
					typeof metadata.value === "object" &&
					!Array.isArray(metadata.value)
						? (metadata.value as Record<string, unknown>)
						: null,
			});
		}
		// Result order follows the request.
		return paths.flatMap((path) => {
			const file = byPath.get(path);
			return file ? [file] : [];
		});
	}

	/** Canonical URLs for this context's Lix and branch. */
	private async entityUrl(
		context: LixContext,
		origin: string,
	): Promise<
		(kind: "file" | "directory", entity: { id: string; path: string }) => string
	> {
		const [repository, defaultId] = await Promise.all([
			this.resolveLixSummary(context.lixId),
			this.client.defaultBranchId(context.lixId),
		]);
		const branch = { id: context.branchId, defaultId };
		return (kind, entity) =>
			canonicalEntityUrl(repository, branch, origin, { kind, ...entity });
	}

	async createCheckpoint(contextToken: string) {
		const context = await this.readContext(contextToken);
		const response = await this.client.execute(
			context.lixId,
			context.branchId,
			{ sql: "SELECT commit_id FROM lix_create_checkpoint()" },
		);
		const commitId = response.rows[0]?.[0];
		if (!commitId || commitId.kind !== "text") {
			throw createLixError(
				"upstream_error",
				"Lix did not return a checkpoint commit id.",
			);
		}
		return { context: contextToken, commitId: commitId.value };
	}

	async restore(contextToken: string, commitId: string) {
		const context = await this.readContext(contextToken);
		const response = await this.client.execute(
			context.lixId,
			context.branchId,
			{
				sql: "INSERT INTO lix_restore (commit_id) VALUES ($1) RETURNING commit_id",
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
				{
					hint: "Pass a commit_id that exists on the selected branch. create_checkpoint returns a usable commit_id.",
				},
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
				{
					hint: "Retry open_lix. If it persists, contact LixRay support.",
				},
			);
		}
		return value.value;
	}

	private async fileInventory(
		lixId: string,
		branchId: string,
	): Promise<{
		fileCount: number;
		directoryCount: number;
		files: Array<{ id: string; path: string }>;
		filePaths: Array<string>;
		filePathsComplete: boolean;
	}> {
		const response = await this.client.execute(lixId, branchId, {
			sql: OPEN_LIX_INVENTORY_SQL,
		});
		const fileCount = wireNonNegativeInt(response.rows[0]?.[0]);
		const directoryCount = wireNonNegativeInt(response.rows[0]?.[1]);
		if (fileCount === undefined || directoryCount === undefined) {
			throw createLixError(
				"upstream_error",
				"Lix did not return file inventory counts.",
				{
					hint: "Retry open_lix. If it persists, inspect lix_file and lix_directory with query_sql.",
				},
			);
		}
		if (fileCount === 0) {
			return {
				fileCount,
				directoryCount,
				files: [],
				filePaths: [],
				filePathsComplete: true,
			};
		}
		const manifest = await this.client.execute(lixId, branchId, {
			sql: OPEN_LIX_FILE_MANIFEST_SQL,
		});
		const files = manifest.rows.map((row) => {
			const id = row[manifest.columns.indexOf("id")];
			const value = row[manifest.columns.indexOf("path")];
			if (
				!value ||
				value.kind !== "text" ||
				id?.kind !== "text" ||
				!ENTITY_UUID_PATTERN.test(id.value)
			) {
				throw createLixError(
					"upstream_error",
					"Lix did not return a valid file path manifest.",
					{
						hint: "Retry open_lix. If it persists, inspect lix_file with query_sql.",
					},
				);
			}
			return { id: id.value, path: value.value };
		});
		const filePaths = files.map((file) => file.path);
		return {
			files,
			fileCount,
			directoryCount,
			filePaths,
			filePathsComplete: filePaths.length === fileCount,
		};
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
			throw contextError("malformed_context", "context must be a string.");
		}
		const parts = token.split(".");
		if (parts.length !== 2) {
			throw contextError("malformed_context", "context is malformed.");
		}
		const [encodedClaims, encodedSignature] = parts;
		let claims: ContextClaims | undefined;
		let signature: Uint8Array<ArrayBuffer> | undefined;
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
			throw contextError("malformed_context", "context is malformed.", {
				expiresAt: finiteTimestamp(claims?.expiresAt),
			});
		}
		const advertisedExpiresAt = finiteTimestamp(claims.expiresAt);
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
			throw contextError("invalid_context", "context is invalid.", {
				expiresAt: advertisedExpiresAt,
			});
		}
		if (
			advertisedExpiresAt === undefined ||
			advertisedExpiresAt <= Date.now()
		) {
			throw contextError("context_expired", "The Lix context has expired.", {
				expiresAt: advertisedExpiresAt,
				lixId: claims.lixId,
				branchId: claims.branchId,
			});
		}
		return { lixId: claims.lixId, branchId: claims.branchId };
	}
}

function contextError(
	code: "context_expired" | "malformed_context" | "invalid_context",
	message: string,
	options: {
		expiresAt?: number;
		lixId?: string;
		branchId?: string;
	} = {},
): LixError {
	const details: Record<string, unknown> = {
		server_time: new Date().toISOString(),
	};
	if (options.expiresAt !== undefined) {
		details.expires_at = new Date(options.expiresAt).toISOString();
	}
	if (options.lixId) details.lix_id = options.lixId;
	if (options.branchId) details.branch_id = options.branchId;
	return createLixError(code, message, {
		hint: CONTEXT_REOPEN_HINT,
		details,
	});
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Files listed per call before `truncated` says to narrow the filter. */
const LIST_FILES_LIMIT = 1000;

const EMPTY_RESPONSE: ExecuteResponse = {
	columns: [],
	rows: [],
	rowsAffected: 0,
	notices: [],
};

export type ReadFile = {
	id: string;
	path: string;
	content: FileContent;
	size: number;
	lixcol_metadata: Record<string, unknown> | null;
};

export type ReadFilesResult = {
	context: string;
	commitId: string;
	files: Array<ReadFile & { url: string }>;
	missing: string[];
};

function normalizeFilePathOrThrow(path: string): string {
	try {
		return normalizeFilePath(path);
	} catch (caught) {
		throw createLixError(
			"invalid_request",
			caught instanceof Error ? caught.message : String(caught),
		);
	}
}

function readIdPathRows(
	response: ExecuteResponse,
): Array<{ id: string; path: string }> {
	const idColumn = response.columns.indexOf("id");
	const pathColumn = response.columns.indexOf("path");
	return response.rows.map((row) => {
		const id = row[idColumn];
		const path = row[pathColumn];
		if (
			id?.kind !== "text" ||
			!ENTITY_UUID_PATTERN.test(id.value) ||
			path?.kind !== "text"
		)
			throw createLixError("upstream_error", "Lix returned an invalid file.");
		return { id: id.value, path: path.value };
	});
}

function wireNonNegativeInt(value: WireValue | undefined): number | undefined {
	if (!value) return undefined;
	if (
		value.kind === "int" &&
		Number.isSafeInteger(value.value) &&
		value.value >= 0
	) {
		return value.value;
	}
	if (
		value.kind === "float" &&
		Number.isFinite(value.value) &&
		value.value >= 0
	) {
		return Math.trunc(value.value);
	}
	if (value.kind === "text" && /^\d+$/.test(value.value)) {
		const parsed = Number(value.value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return undefined;
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

const ENTITY_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonicalLookupPath(
	path: string,
	kind: "file" | "directory",
): string | null {
	if (!path.startsWith("/")) return null;
	const normalized =
		kind === "directory" && path !== "/" ? path.replace(/\/$/, "") : path;
	if (normalized === "/" && path !== "/") return null;
	if (
		!normalized.startsWith("/") ||
		normalized.includes("\\") ||
		[...normalized].some((character) => character.charCodeAt(0) < 32) ||
		(normalized !== "/" &&
			normalized
				.slice(1)
				.split("/")
				.some((part) => !part || part === "." || part === ".."))
	)
		return null;
	return normalized;
}
/** A URL names its branch only when that is not the Lix's default branch. */
function canonicalEntityUrl(
	repository: LixSummary,
	branch: { id: string; defaultId: string },
	origin: string,
	entity?: { kind: "file" | "directory"; id: string; path: string },
): string {
	const path =
		entity && !(entity.kind === "directory" && entity.path === "/")
			? entityRoutePath(
					repository.namespace.handle,
					repository.slug,
					entity.kind,
					entity.id,
					entity.path,
				)
			: `/@${encodeURIComponent(repository.namespace.handle)}/${encodeURIComponent(repository.slug)}`;
	const url = new URL(path, origin);
	if (branch.id !== branch.defaultId) url.searchParams.set("branch", branch.id);
	return url.href;
}
