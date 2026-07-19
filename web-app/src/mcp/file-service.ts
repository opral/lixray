import { base64ToBytes, bytesToBase64 } from "../lib/base64.ts";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const DEFAULT_READ_LINE_COUNT = 400;
export const MAX_READ_LINE_COUNT = 1000;
export const MAX_PATH_LENGTH = 1024;

const WORKSPACE_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALIFIED_WORKSPACE_REF_PATTERN =
	/^@([a-z0-9](?:-?[a-z0-9]){0,38})\/([a-z0-9](?:-?[a-z0-9]){0,99})$/;

export type WireValue =
	| { kind: "null"; value?: null }
	| { kind: "bool"; value: boolean }
	| { kind: "int"; value: number }
	| { kind: "float"; value: number }
	| { kind: "text"; value: string }
	| { kind: "blob"; base64: string }
	| { kind: "json"; value: unknown };

export interface ExecuteRequest {
	branchId: string;
	sql: string;
	params?: Array<WireValue>;
	options?: { originKey?: string };
}

export interface ExecuteResponse {
	columns: Array<string>;
	rows: Array<Array<WireValue>>;
	rowsAffected: number;
	notices: Array<unknown>;
}

export interface ExecuteScriptResponse {
	results: Array<ExecuteResponse>;
}

export interface ExecuteBatchRequest {
	branchId: string;
	statements: Array<{
		sql: string;
		params?: Array<WireValue>;
	}>;
	options?: { originKey?: string };
}

export interface Branch {
	id: string;
	name: string;
	hidden: boolean;
	commitId: string;
}

export interface BranchState {
	branches: Array<Branch>;
	currentBranchId: string;
}

export interface WorkspaceSummary {
	id: string;
	name: string;
	slug: string;
	organization: { id: string; name: string; handle: string };
}

export interface LixRuntimeClient {
	listWorkspaces(): Promise<Array<WorkspaceSummary>>;
	listBranches(workspaceId: string): Promise<BranchState>;
	execute(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse>;
	executeBatch(
		workspaceId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse>;
}

export interface AgentReviewSource {
	agent: "claude" | "codex";
	sessionId?: string;
}

export interface LixFileServiceOptions {
	agentReview?: AgentReviewSource;
}

export type EntryKind = "file" | "directory";

export interface EntrySummary {
	kind: EntryKind;
	path: string;
	name: string;
	revision: string;
	updatedAt: string;
	size?: number | null;
}

export interface FileSnapshot {
	path: string;
	content: string;
	size: number;
	revision: string;
	updatedAt: string;
	totalLines: number;
	startLine: number;
	endLine: number;
	hasMore: boolean;
}

export type FileServiceErrorCode =
	| "invalid_path"
	| "not_found"
	| "already_exists"
	| "conflict"
	| "not_utf8"
	| "file_too_large"
	| "invalid_edit"
	| "recursive_required"
	| "ambiguous_workspace_ref"
	| "upstream_error"
	| `LIX_${string}`;

export class FileServiceError extends Error {
	readonly code: FileServiceErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(
		code: FileServiceErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "FileServiceError";
		this.code = code;
		this.details = details;
	}
}

export class LixFileService {
	private readonly client: LixRuntimeClient;
	private readonly agentReview: AgentReviewSource | undefined;

	constructor(client: LixRuntimeClient, options: LixFileServiceOptions = {}) {
		this.client = client;
		this.agentReview = options.agentReview;
	}

	async listWorkspaces(): Promise<Array<WorkspaceSummary>> {
		return this.client.listWorkspaces();
	}

	async resolveWorkspaceRef(workspaceRef: string): Promise<string> {
		if (WORKSPACE_UUID_PATTERN.test(workspaceRef)) {
			return workspaceRef.toLowerCase();
		}

		const qualified = QUALIFIED_WORKSPACE_REF_PATTERN.exec(workspaceRef);
		const workspaces = await this.listWorkspaces();
		const matches = qualified
			? workspaces.filter(
					(workspace) =>
						workspace.organization.handle === qualified[1] &&
						workspace.slug === qualified[2],
				)
			: workspaces.filter((workspace) => workspace.slug === workspaceRef);

		if (matches.length === 1) return matches[0].id;
		if (matches.length === 0) {
			throw new FileServiceError("not_found", "Workspace not found.");
		}
		throw new FileServiceError(
			"ambiguous_workspace_ref",
			"Workspace slug is ambiguous; use an exact workspace UUID or @namespace/slug.",
		);
	}

	async listBranches(workspaceId: string): Promise<BranchState> {
		return this.client.listBranches(workspaceId);
	}

	async resolveBranchId(
		workspaceId: string,
		branchId: string | undefined,
	): Promise<string> {
		if (branchId !== undefined) return branchId;
		return (await this.client.listBranches(workspaceId)).currentBranchId;
	}

	async executeSql(
		workspaceId: string,
		branchId: string,
		statements: ExecuteBatchRequest["statements"],
	): Promise<ExecuteScriptResponse> {
		return this.client.executeBatch(workspaceId, { branchId, statements });
	}

	async listDirectory(
		workspaceId: string,
		branchId: string,
		rawPath: string,
	): Promise<Array<EntrySummary>> {
		const path = directoryPath(rawPath, { allowRoot: true });
		const directoryId = await this.resolveDirectoryId(
			workspaceId,
			branchId,
			path,
		);
		const directoryFilter =
			directoryId === null ? "parent_id IS NULL" : "parent_id = $1";
		const params = directoryId === null ? [] : [text(directoryId)];
		const fileFilter =
			directoryId === null ? "directory_id IS NULL" : "directory_id = $1";
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: `SELECT entry_kind, path, name, lixcol_metadata, lixcol_change_id, lixcol_updated_at FROM (
				SELECT 0 AS entry_kind, path, name, lix_json('null') AS lixcol_metadata, lixcol_change_id, lixcol_updated_at FROM lix_directory WHERE ${directoryFilter}
				UNION ALL
				SELECT 1 AS entry_kind, path, name, lixcol_metadata, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE ${fileFilter}
			) ORDER BY entry_kind, name`,
			params,
		});

		return result.rows.map((row): EntrySummary => {
			const kind = asEntryKind(row[0]);
			return kind === "directory"
				? {
						kind,
						path: asText(row[1]),
						name: asText(row[2]),
						revision: asText(row[4]),
						updatedAt: asText(row[5]),
					}
				: {
						kind,
						path: asText(row[1]),
						name: asText(row[2]),
						size: sizeFromMetadata(row[3]),
						revision: asText(row[4]),
						updatedAt: asText(row[5]),
					};
		});
	}

	async findFiles(
		workspaceId: string,
		branchId: string,
		query: string,
		rawRoot = "/",
	): Promise<Array<EntrySummary>> {
		const root = directoryPath(rawRoot, { allowRoot: true });
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery || normalizedQuery.length > 100) {
			throw new FileServiceError(
				"invalid_path",
				"Search query must contain between 1 and 100 characters.",
			);
		}
		const prefixClause = root === "/" ? "" : "path >= $2 AND path < $3 AND ";
		const params =
			root === "/"
				? [text(`%${normalizedQuery}%`)]
				: [
						text(`%${normalizedQuery}%`),
						text(root),
						text(prefixUpperBound(root)),
					];
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: `SELECT path, name, lixcol_metadata, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE ${prefixClause}LOWER(path) LIKE $1 ORDER BY path`,
			params,
		});
		return result.rows.map(
			(row): EntrySummary => ({
				kind: "file",
				path: asText(row[0]),
				name: asText(row[1]),
				size: sizeFromMetadata(row[2]),
				revision: asText(row[3]),
				updatedAt: asText(row[4]),
			}),
		);
	}

	async readFile(
		workspaceId: string,
		branchId: string,
		rawPath: string,
		startLine = 1,
		lineCount = DEFAULT_READ_LINE_COUNT,
	): Promise<FileSnapshot> {
		const path = filePath(rawPath);
		const file = await this.loadFile(workspaceId, branchId, path);
		const boundedStart = Math.max(Math.trunc(startLine), 1);
		const boundedCount = Math.min(
			Math.max(Math.trunc(lineCount), 1),
			MAX_READ_LINE_COUNT,
		);
		const lines = file.content.split("\n");
		const startIndex = Math.min(boundedStart - 1, lines.length);
		const selected = lines.slice(startIndex, startIndex + boundedCount);
		const endLine = selected.length === 0 ? 0 : startIndex + selected.length;
		return {
			path,
			content: selected.join("\n"),
			size: file.size,
			revision: file.revision,
			updatedAt: file.updatedAt,
			totalLines: lines.length,
			startLine: selected.length === 0 ? 0 : startIndex + 1,
			endLine,
			hasMore: endLine < lines.length,
		};
	}

	async writeFile(
		workspaceId: string,
		branchId: string,
		rawPath: string,
		content: string,
		expectedRevision?: string,
	): Promise<EntrySummary> {
		const path = filePath(rawPath);
		const bytes = utf8Bytes(content);
		assertTextFileSize(bytes.length);

		if (
			expectedRevision === undefined &&
			(await this.entryExists(workspaceId, branchId, path))
		) {
			try {
				expectedRevision = (
					await this.loadEntrySummary(workspaceId, branchId, path, "file")
				).revision;
			} catch (caught) {
				if (caught instanceof FileServiceError && caught.code === "not_found") {
					throw new FileServiceError(
						"already_exists",
						`A directory already exists at ${path}/.`,
					);
				}
				throw caught;
			}
		}

		if (expectedRevision === undefined) {
			await this.withAgentReview(workspaceId, branchId, () =>
				this.client.execute(workspaceId, {
					branchId,
					sql: "INSERT INTO lix_file (path, data, lixcol_metadata) VALUES ($1, $2, $3)",
					params: [
						text(path),
						blob(bytes),
						{ kind: "json", value: { size: bytes.length } },
					],
				}),
			);
		} else {
			await this.withAgentReview(workspaceId, branchId, async () => {
				const response = await this.client.executeBatch(workspaceId, {
					branchId,
					statements: [
						{
							sql: "UPDATE lix_file SET data = $1, lixcol_metadata = $2 WHERE path = $3 AND lixcol_change_id = $4",
							params: [
								blob(bytes),
								{ kind: "json", value: { size: bytes.length } },
								text(path),
								text(expectedRevision),
							],
						},
					],
				});
				assertGuardedMutationApplied(path, response);
			});
		}

		return this.loadEntrySummary(workspaceId, branchId, path, "file");
	}

	private async withAgentReview<T>(
		workspaceId: string,
		branchId: string,
		mutation: () => Promise<T>,
	): Promise<T> {
		if (!this.agentReview) return mutation();
		const beforeCommitId = await this.branchCommitId(workspaceId, branchId);
		const startedAt = Date.now();
		const result = await mutation();
		const afterCommitId = await this.branchCommitId(workspaceId, branchId);
		if (beforeCommitId !== afterCommitId) {
			await this.appendAgentReview(workspaceId, branchId, {
				id: `mcp-${crypto.randomUUID()}`,
				sourceId: this.agentReview.agent,
				beforeCommitId,
				afterCommitId,
				...(this.agentReview.sessionId
					? { sessionId: this.agentReview.sessionId }
					: {}),
				startedAt,
				completedAt: Date.now(),
			});
		}
		return result;
	}

	private async branchCommitId(
		workspaceId: string,
		branchId: string,
	): Promise<string> {
		const branch = (await this.client.listBranches(workspaceId)).branches.find(
			(candidate) => candidate.id === branchId,
		);
		if (!branch) {
			throw new FileServiceError("not_found", `Branch not found: ${branchId}`);
		}
		return branch.commitId;
	}

	private async appendAgentReview(
		workspaceId: string,
		branchId: string,
		range: Record<string, unknown>,
	): Promise<void> {
		const rangeId = typeof range.id === "string" ? range.id : "";
		if (!rangeId) throw new Error("Agent review ranges require an id");
		const key = `atelier_agent_turn_commit_range:${encodeURIComponent(rangeId)}`;
		await this.client.execute(workspaceId, {
			branchId,
			sql: "INSERT INTO lix_key_value_by_branch (key, value, lixcol_branch_id, lixcol_global, lixcol_untracked) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key, lixcol_branch_id) DO NOTHING",
			params: [
				text(key),
				{ kind: "json", value: range },
				text(branchId),
				{ kind: "bool", value: branchId === "global" },
				{ kind: "bool", value: true },
			],
		});
	}

	async editFile(
		workspaceId: string,
		branchId: string,
		rawPath: string,
		expectedRevision: string | undefined,
		edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
	): Promise<EntrySummary> {
		const path = filePath(rawPath);
		if (edits.length === 0 || edits.length > 50) {
			throw new FileServiceError(
				"invalid_edit",
				"Provide between 1 and 50 exact text edits.",
			);
		}
		const file = await this.loadFile(workspaceId, branchId, path);
		if (expectedRevision !== undefined && file.revision !== expectedRevision) {
			throw conflict(path);
		}
		const revision = expectedRevision ?? file.revision;
		let next = file.content;
		for (const edit of edits) {
			if (!edit.oldText) {
				throw new FileServiceError(
					"invalid_edit",
					"old_text must not be empty.",
				);
			}
			const matches = occurrenceCount(next, edit.oldText);
			if (matches === 0) {
				throw new FileServiceError(
					"invalid_edit",
					"An old_text value was not found in the current file.",
				);
			}
			if (!edit.replaceAll && matches !== 1) {
				throw new FileServiceError(
					"invalid_edit",
					`An old_text value matched ${matches} times; make it unique or set replace_all.`,
					{ matches },
				);
			}
			next = edit.replaceAll
				? next.split(edit.oldText).join(edit.newText)
				: next.replace(edit.oldText, () => edit.newText);
		}
		return this.writeFile(workspaceId, branchId, path, next, revision);
	}

	async createDirectory(
		workspaceId: string,
		branchId: string,
		rawPath: string,
	): Promise<EntrySummary> {
		const path = directoryPath(rawPath, { allowRoot: false });
		if (await this.entryExists(workspaceId, branchId, path)) {
			throw new FileServiceError(
				"already_exists",
				`An entry already exists at ${path}.`,
			);
		}
		await this.client.execute(workspaceId, {
			branchId,
			sql: "INSERT INTO lix_directory (path) VALUES ($1)",
			params: [text(path)],
		});
		return this.loadEntrySummary(workspaceId, branchId, path, "directory");
	}

	async moveEntry(
		workspaceId: string,
		branchId: string,
		rawSourcePath: string,
		rawDestinationPath: string,
		expectedRevision: string | undefined,
	): Promise<EntrySummary> {
		const kind: EntryKind = rawSourcePath.endsWith("/") ? "directory" : "file";
		const source = entryPath(rawSourcePath, kind, false);
		const destination = entryPath(rawDestinationPath, kind, false);
		if (source === destination) {
			throw new FileServiceError(
				"invalid_path",
				"Source and destination paths must differ.",
			);
		}
		if (kind === "directory" && destination.startsWith(source)) {
			throw new FileServiceError(
				"invalid_path",
				"A directory cannot be moved inside itself.",
			);
		}
		if (await this.entryExists(workspaceId, branchId, destination)) {
			throw new FileServiceError(
				"already_exists",
				`An entry already exists at ${destination}.`,
			);
		}
		const revision =
			expectedRevision ??
			(await this.loadEntrySummary(workspaceId, branchId, source, kind))
				.revision;
		const table = kind === "file" ? "lix_file" : "lix_directory";
		const response = await this.client.executeBatch(workspaceId, {
			branchId,
			statements: [
				{
					sql: `UPDATE ${table} SET path = $1 WHERE path = $2 AND lixcol_change_id = $3`,
					params: [text(destination), text(source), text(revision)],
				},
			],
		});
		assertGuardedMutationApplied(source, response);
		return this.loadEntrySummary(workspaceId, branchId, destination, kind);
	}

	async deleteEntry(
		workspaceId: string,
		branchId: string,
		rawPath: string,
		expectedRevision: string | undefined,
		recursive = false,
	): Promise<{ path: string; deleted: true }> {
		const kind: EntryKind = rawPath.endsWith("/") ? "directory" : "file";
		const path = entryPath(rawPath, kind, false);
		if (kind === "directory" && !recursive) {
			throw new FileServiceError(
				"recursive_required",
				"Directory deletion requires recursive=true because it removes the entire subtree.",
			);
		}
		const revision =
			expectedRevision ??
			(await this.loadEntrySummary(workspaceId, branchId, path, kind)).revision;
		const table = kind === "file" ? "lix_file" : "lix_directory";
		const response = await this.client.executeBatch(workspaceId, {
			branchId,
			statements: [
				{
					sql: `DELETE FROM ${table} WHERE path = $1 AND lixcol_change_id = $2`,
					params: [text(path), text(revision)],
				},
			],
		});
		assertGuardedMutationApplied(path, response);
		return { path, deleted: true };
	}

	private async resolveDirectoryId(
		workspaceId: string,
		branchId: string,
		path: string,
	): Promise<string | null> {
		if (path === "/") return null;
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: "SELECT id FROM lix_directory WHERE path = $1",
			params: [text(path)],
		});
		const id = result.rows[0]?.[0];
		if (!id) {
			throw new FileServiceError("not_found", `Directory not found: ${path}`);
		}
		return asText(id);
	}

	private async loadFile(
		workspaceId: string,
		branchId: string,
		path: string,
	): Promise<{
		content: string;
		size: number;
		revision: string;
		updatedAt: string;
	}> {
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: "SELECT data, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE path = $1",
			params: [text(path)],
		});
		const row = result.rows[0];
		if (!row) {
			throw new FileServiceError("not_found", `File not found: ${path}`);
		}
		const bytes = asBlob(row[0]);
		assertTextFileSize(bytes.length);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new FileServiceError(
				"not_utf8",
				`File is not valid UTF-8 text: ${path}`,
			);
		}
		return {
			content,
			size: bytes.length,
			revision: asText(row[1]),
			updatedAt: asText(row[2]),
		};
	}

	private async loadEntrySummary(
		workspaceId: string,
		branchId: string,
		path: string,
		kind: EntryKind,
	): Promise<EntrySummary> {
		const table = kind === "file" ? "lix_file" : "lix_directory";
		const metadata = kind === "file" ? ", lixcol_metadata" : "";
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: `SELECT path, name, lixcol_change_id, lixcol_updated_at${metadata} FROM ${table} WHERE path = $1`,
			params: [text(path)],
		});
		const row = result.rows[0];
		if (!row) {
			throw new FileServiceError("not_found", `Entry not found: ${path}`);
		}
		return {
			kind,
			path: asText(row[0]),
			name: asText(row[1]),
			revision: asText(row[2]),
			updatedAt: asText(row[3]),
			...(kind === "file" ? { size: sizeFromMetadata(row[4]) } : {}),
		};
	}

	private async entryExists(
		workspaceId: string,
		branchId: string,
		path: string,
	): Promise<boolean> {
		const fileCandidate = path.endsWith("/") ? path.slice(0, -1) : path;
		const directoryCandidate = `${fileCandidate}/`;
		const result = await this.client.execute(workspaceId, {
			branchId,
			sql: "SELECT id FROM lix_file WHERE path = $1 UNION ALL SELECT id FROM lix_directory WHERE path = $2",
			params: [text(fileCandidate), text(directoryCandidate)],
		});
		return result.rows.length > 0;
	}
}

export function filePath(rawPath: string): string {
	return entryPath(rawPath, "file", false);
}

export function directoryPath(
	rawPath: string,
	options: { allowRoot: boolean },
): string {
	return entryPath(rawPath, "directory", options.allowRoot);
}

function entryPath(
	rawPath: string,
	kind: EntryKind,
	allowRoot: boolean,
): string {
	if (
		typeof rawPath !== "string" ||
		!rawPath.startsWith("/") ||
		rawPath.length > MAX_PATH_LENGTH ||
		rawPath.includes("\0") ||
		rawPath.includes("//")
	) {
		throw invalidPath(rawPath);
	}
	if (rawPath === "/") {
		if (kind === "directory" && allowRoot) return rawPath;
		throw invalidPath(rawPath);
	}
	const hasDirectorySuffix = rawPath.endsWith("/");
	if ((kind === "directory") !== hasDirectorySuffix) {
		throw invalidPath(rawPath);
	}
	const segments = rawPath.split("/").filter(Boolean);
	if (
		segments.length === 0 ||
		segments.some(
			(segment) => segment === "." || segment === ".." || segment.trim() === "",
		)
	) {
		throw invalidPath(rawPath);
	}
	return rawPath;
}

function invalidPath(path: string): FileServiceError {
	return new FileServiceError(
		"invalid_path",
		`Path must be canonical and absolute${path ? `: ${path}` : "."}`,
	);
}

function prefixUpperBound(directory: string): string {
	return `${directory.slice(0, -1)}0`;
}

function conflict(path: string): FileServiceError {
	return new FileServiceError(
		"conflict",
		`The entry changed since it was read: ${path}. Read it again before retrying.`,
		{ path },
	);
}

function assertGuardedMutationApplied(
	path: string,
	response: ExecuteScriptResponse,
): void {
	if (response.results.length !== 1) {
		throw new FileServiceError(
			"upstream_error",
			"Lix returned an invalid guarded mutation result.",
		);
	}
	if (response.results[0]?.rowsAffected === 1) return;
	throw conflict(path);
}

function utf8Bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function assertTextFileSize(size: number): void {
	if (size > MAX_TEXT_FILE_BYTES) {
		throw new FileServiceError(
			"file_too_large",
			`Text files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`,
			{ size, maxBytes: MAX_TEXT_FILE_BYTES },
		);
	}
}

function occurrenceCount(value: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = value.indexOf(needle, offset);
		if (index === -1) return count;
		count += 1;
		offset = index + needle.length;
	}
}

function text(value: string): WireValue {
	return { kind: "text", value };
}

function blob(bytes: Uint8Array): WireValue {
	return { kind: "blob", base64: bytesToBase64(bytes) };
}

function asText(value: WireValue | undefined): string {
	if (!value || value.kind !== "text") {
		throw new FileServiceError(
			"upstream_error",
			"Expected a text value from Lix.",
		);
	}
	return value.value;
}

function asEntryKind(value: WireValue | undefined): EntryKind {
	if (value?.kind === "int") {
		if (value.value === 0) return "directory";
		if (value.value === 1) return "file";
	}
	throw new FileServiceError(
		"upstream_error",
		"Expected a directory or file entry kind from Lix.",
	);
}

function asBlob(value: WireValue | undefined): Uint8Array {
	if (!value || value.kind !== "blob") {
		throw new FileServiceError(
			"upstream_error",
			"Expected file bytes from Lix.",
		);
	}
	return base64ToBytes(value.base64);
}

function sizeFromMetadata(value: WireValue | undefined): number | null {
	if (!value || value.kind !== "json") return null;
	const metadata = value.value;
	if (!metadata || typeof metadata !== "object" || !("size" in metadata)) {
		return null;
	}
	const size = metadata.size;
	return typeof size === "number" && Number.isFinite(size) && size >= 0
		? size
		: null;
}
