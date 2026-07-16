import assert from "node:assert/strict";
import test from "node:test";
import {
	FileServiceError,
	LixFileService,
	MAX_PATH_LENGTH,
	MAX_TEXT_FILE_BYTES,
	directoryPath,
	filePath,
	type BranchState,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	type LixRuntimeClient,
	type WorkspaceSummary,
	type FilesystemMutationOutcome,
	type FilesystemMutationRequest,
	type WireValue,
} from "./file-service.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const UUID_SLUG_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const BRANCH_ID = "main";

void test("workspace refs resolve UUIDs, unique slugs, and qualified slugs", async () => {
	const client = new MemoryLixRuntimeClient();
	client.workspaceSummaries.push({
		id: OTHER_WORKSPACE_ID,
		name: "Other personal",
		slug: "personal",
		organization: { id: "org-2", name: "Other", handle: "other" },
	});
	client.workspaceSummaries.push({
		id: UUID_SLUG_WORKSPACE_ID,
		name: "UUID slug",
		slug: WORKSPACE_ID,
		organization: { id: "org-3", name: "UUID Slugs", handle: "uuid-slugs" },
	});
	const service = new LixFileService(client);

	assert.equal(await service.resolveWorkspaceRef(WORKSPACE_ID), WORKSPACE_ID);
	assert.equal(
		await service.resolveWorkspaceRef(`@uuid-slugs/${WORKSPACE_ID}`),
		UUID_SLUG_WORKSPACE_ID,
	);
	assert.equal(
		await service.resolveWorkspaceRef("@example/personal"),
		WORKSPACE_ID,
	);
	assert.equal(
		await service.resolveWorkspaceRef("@other/personal"),
		OTHER_WORKSPACE_ID,
	);
	await assert.rejects(
		service.resolveWorkspaceRef("personal"),
		hasCode("ambiguous_workspace_ref"),
	);
	await assert.rejects(
		service.resolveWorkspaceRef("missing"),
		hasCode("not_found"),
	);
});

void test("unique bare workspace slugs resolve without discovery by the caller", async () => {
	const service = new LixFileService(new MemoryLixRuntimeClient());
	assert.equal(await service.resolveWorkspaceRef("personal"), WORKSPACE_ID);
});

void test("canonical path validation rejects ambiguous and unsafe paths", () => {
	for (const path of [
		"relative.txt",
		"/../secret.txt",
		"/a/./file.txt",
		"/a//file.txt",
		"/nul\0file.txt",
		"/directory/",
		`/${"a".repeat(MAX_PATH_LENGTH)}`,
	]) {
		assert.throws(() => filePath(path), hasCode("invalid_path"), path);
	}
	assert.throws(
		() => directoryPath("/directory", { allowRoot: true }),
		hasCode("invalid_path"),
	);
	assert.throws(
		() => directoryPath("/", { allowRoot: false }),
		hasCode("invalid_path"),
	);
	assert.equal(filePath("/src/index.ts"), "/src/index.ts");
	assert.equal(directoryPath("/src/", { allowRoot: true }), "/src/");
	assert.equal(directoryPath("/", { allowRoot: true }), "/");
});

void test("read_file validates UTF-8 and paginates by line with a revision", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile(
		"/notes.txt",
		new TextEncoder().encode("one\ntwo\nthree"),
		"rev-7",
	);
	const service = new LixFileService(client);

	const page = await service.readFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/notes.txt",
		2,
		1,
	);
	assert.deepEqual(page, {
		path: "/notes.txt",
		content: "two",
		size: 13,
		revision: "rev-7",
		updatedAt: "2026-07-10T12:00:00.000Z",
		totalLines: 3,
		startLine: 2,
		endLine: 2,
		hasMore: true,
	});

	client.addFile("/binary.dat", new Uint8Array([0xc3, 0x28]), "rev-1");
	await assert.rejects(
		service.readFile(WORKSPACE_ID, BRANCH_ID, "/binary.dat"),
		hasCode("not_utf8"),
	);
});

void test("text file reads and writes enforce the one MiB byte limit", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile(
		"/large.txt",
		new Uint8Array(MAX_TEXT_FILE_BYTES + 1),
		"rev-1",
	);
	const service = new LixFileService(client);

	await assert.rejects(
		service.readFile(WORKSPACE_ID, BRANCH_ID, "/large.txt"),
		hasCode("file_too_large"),
	);
	await assert.rejects(
		service.writeFile(
			WORKSPACE_ID,
			BRANCH_ID,
			"/too-large.txt",
			"x".repeat(MAX_TEXT_FILE_BYTES + 1),
		),
		hasCode("file_too_large"),
	);
});

void test("write_file overwrites the current file without a revision and compare-and-swaps with one", async () => {
	const client = new MemoryLixRuntimeClient();
	const service = new LixFileService(client);

	const created = await service.writeFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/new.txt",
		"first",
	);
	assert.equal(created.path, "/new.txt");
	assert.equal(created.revision, "rev-1");
	const overwritten = await service.writeFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/new.txt",
		"overwrite",
	);
	assert.equal(overwritten.revision, "rev-2");
	assert.equal(client.fileText("/new.txt"), "overwrite");
	await assert.rejects(
		service.writeFile(
			WORKSPACE_ID,
			BRANCH_ID,
			"/new.txt",
			"overwrite",
			"stale",
		),
		hasCode("conflict"),
	);

	const replaced = await service.writeFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/new.txt",
		"second",
		overwritten.revision,
	);
	assert.equal(replaced.revision, "rev-3");
	assert.equal(client.fileText("/new.txt"), "second");
});

void test("find_files returns every matching file without a result cap", async () => {
	const client = new MemoryLixRuntimeClient();
	for (let index = 0; index < 125; index += 1) {
		client.addFile(
			`/match-${index.toString().padStart(3, "0")}.txt`,
			new TextEncoder().encode(String(index)),
			`rev-${index + 1}`,
		);
	}
	const service = new LixFileService(client);

	const files = await service.findFiles(WORKSPACE_ID, BRANCH_ID, "match-");
	assert.equal(files.length, 125);
	assert.equal(files[0]?.path, "/match-000.txt");
	assert.equal(files.at(-1)?.path, "/match-124.txt");
});

void test("edit_file requires unique exact matches unless replace_all is explicit", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile(
		"/edit.txt",
		new TextEncoder().encode("red red blue"),
		"rev-3",
	);
	const service = new LixFileService(client);

	await assert.rejects(
		service.editFile(WORKSPACE_ID, BRANCH_ID, "/edit.txt", "rev-3", [
			{ oldText: "red", newText: "green" },
		]),
		hasCode("invalid_edit"),
	);
	await assert.rejects(
		service.editFile(WORKSPACE_ID, BRANCH_ID, "/edit.txt", "stale", [
			{ oldText: "blue", newText: "cyan" },
		]),
		hasCode("conflict"),
	);

	const edited = await service.editFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/edit.txt",
		"rev-3",
		[
			{ oldText: "red", newText: "green", replaceAll: true },
			{ oldText: "blue", newText: "cyan" },
		],
	);
	assert.equal(edited.revision, "rev-4");
	assert.equal(client.fileText("/edit.txt"), "green green cyan");

	const editedWithoutRevision = await service.editFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/edit.txt",
		undefined,
		[{ oldText: "cyan", newText: "blue" }],
	);
	assert.equal(editedWithoutRevision.revision, "rev-5");
	assert.equal(client.fileText("/edit.txt"), "green green blue");
});

void test("edit_file treats replacement text literally", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/literal.txt", new TextEncoder().encode("before"), "rev-1");
	const service = new LixFileService(client);
	const replacement = "$$$ profits $& $` $' $1";

	await service.editFile(WORKSPACE_ID, BRANCH_ID, "/literal.txt", "rev-1", [
		{ oldText: "before", newText: replacement },
	]);

	assert.equal(client.fileText("/literal.txt"), replacement);
});

void test("agent-authenticated edits persist an Atelier review range", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/review.md", new TextEncoder().encode("before"), "rev-3");
	const service = new LixFileService(client, {
		agentReview: { agent: "codex", sessionId: "oauth-client-1" },
	});

	await service.editFile(WORKSPACE_ID, BRANCH_ID, "/review.md", "rev-3", [
		{ oldText: "before", newText: "after" },
	]);

	const ranges = client.agentReviewRanges();
	assert.equal(ranges.length, 1);
	assert.deepEqual(
		{
			sourceId: ranges[0]?.sourceId,
			beforeCommitId: ranges[0]?.beforeCommitId,
			afterCommitId: ranges[0]?.afterCommitId,
			sessionId: ranges[0]?.sessionId,
		},
		{
			sourceId: "codex",
			beforeCommitId: "commit-3",
			afterCommitId: "commit-4",
			sessionId: "oauth-client-1",
		},
	);
});

void test("agent-authenticated creates persist an Atelier review range", async () => {
	const client = new MemoryLixRuntimeClient();
	const service = new LixFileService(client, {
		agentReview: { agent: "codex", sessionId: "oauth-client-1" },
	});

	await service.writeFile(
		WORKSPACE_ID,
		BRANCH_ID,
		"/created-by-agent.md",
		"created",
	);

	const ranges = client.agentReviewRanges();
	assert.equal(ranges.length, 1);
	assert.deepEqual(
		{
			sourceId: ranges[0]?.sourceId,
			beforeCommitId: ranges[0]?.beforeCommitId,
			afterCommitId: ranges[0]?.afterCommitId,
			sessionId: ranges[0]?.sessionId,
		},
		{
			sourceId: "codex",
			beforeCommitId: "commit-0",
			afterCommitId: "commit-1",
			sessionId: "oauth-client-1",
		},
	);
});

void test("agent reviews discard legacy ranges after the Atelier hard cut", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/review.md", new TextEncoder().encode("before"), "rev-3");
	client.setAgentReviewRanges([
		{
			id: "legacy-review",
			agent: "codex",
			beforeCommitId: "commit-1",
			afterCommitId: "commit-2",
			startedAt: 1,
			completedAt: 2,
		},
	]);
	const service = new LixFileService(client, {
		agentReview: { agent: "codex", sessionId: "oauth-client-1" },
	});

	await service.editFile(WORKSPACE_ID, BRANCH_ID, "/review.md", "rev-3", [
		{ oldText: "before", newText: "after" },
	]);

	const ranges = client.agentReviewRanges();
	assert.equal(ranges.length, 1);
	assert.equal(ranges[0]?.sourceId, "codex");
	assert.equal(ranges[0]?.agent, undefined);
});

void test("move_entry never overwrites and accepts an omitted source revision", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/source.txt", new TextEncoder().encode("source"), "rev-4");
	client.addFile("/taken.txt", new TextEncoder().encode("taken"), "rev-2");
	const service = new LixFileService(client);

	await assert.rejects(
		service.moveEntry(
			WORKSPACE_ID,
			BRANCH_ID,
			"/source.txt",
			"/taken.txt",
			"rev-4",
		),
		hasCode("already_exists"),
	);
	await assert.rejects(
		service.moveEntry(
			WORKSPACE_ID,
			BRANCH_ID,
			"/source.txt",
			"/renamed.txt",
			"stale",
		),
		hasCode("conflict"),
	);

	const moved = await service.moveEntry(
		WORKSPACE_ID,
		BRANCH_ID,
		"/source.txt",
		"/renamed.txt",
		undefined,
	);
	assert.equal(moved.path, "/renamed.txt");
	assert.equal(client.fileText("/renamed.txt"), "source");
	assert.equal(client.hasFile("/source.txt"), false);
});

void test("directory deletion requires recursive confirmation and accepts an omitted revision", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addDirectory("/docs/", "rev-9");
	client.addFile("/docs/readme.md", new TextEncoder().encode("hello"), "rev-1");
	const service = new LixFileService(client);

	await assert.rejects(
		service.deleteEntry(WORKSPACE_ID, BRANCH_ID, "/docs/", "rev-9"),
		hasCode("recursive_required"),
	);
	await assert.rejects(
		service.deleteEntry(WORKSPACE_ID, BRANCH_ID, "/docs/", "stale", true),
		hasCode("conflict"),
	);
	assert.deepEqual(
		await service.deleteEntry(
			WORKSPACE_ID,
			BRANCH_ID,
			"/docs/",
			undefined,
			true,
		),
		{ path: "/docs/", deleted: true },
	);
	assert.equal(client.hasFile("/docs/readme.md"), false);
});

type StoredFile = { bytes: Uint8Array; revision: string };
type StoredDirectory = { revision: string; id: string };

class MemoryLixRuntimeClient implements LixRuntimeClient {
	readonly workspaceSummaries: Array<WorkspaceSummary> = [
		{
			id: WORKSPACE_ID,
			name: "Personal",
			slug: "personal",
			organization: { id: "org-1", name: "Example", handle: "example" },
		},
	];
	private readonly files = new Map<string, StoredFile>();
	private readonly directories = new Map<string, StoredDirectory>();
	private revisionCounter = 0;
	private reviewStore: { ranges: Array<Record<string, unknown>> } | undefined;
	private readonly normalizedReviewRanges = new Map<
		string,
		Record<string, unknown>
	>();

	addFile(path: string, bytes: Uint8Array, revision: string): void {
		this.files.set(path, { bytes, revision });
		this.observeRevision(revision);
	}

	addDirectory(path: string, revision: string): void {
		this.directories.set(path, { revision, id: `dir:${path}` });
		this.observeRevision(revision);
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	fileText(path: string): string {
		const file = this.files.get(path);
		assert.ok(file);
		return new TextDecoder().decode(file.bytes);
	}

	agentReviewRanges(): Array<Record<string, unknown>> {
		return [...this.normalizedReviewRanges.values()];
	}

	setAgentReviewRanges(ranges: Array<Record<string, unknown>>): void {
		this.reviewStore = { ranges };
	}

	async listWorkspaces() {
		return this.workspaceSummaries.map((workspace) => ({
			...workspace,
			organization: { ...workspace.organization },
		}));
	}

	async listBranches(): Promise<BranchState> {
		return {
			branches: [
				{
					id: BRANCH_ID,
					name: "main",
					hidden: false,
					commitId: `commit-${this.revisionCounter}`,
				},
			],
			currentBranchId: BRANCH_ID,
		};
	}

	async execute(
		_workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		assert.equal(request.branchId, BRANCH_ID);
		const sql = request.sql;
		const params = request.params ?? [];

		if (
			sql ===
			"SELECT value FROM lix_key_value_by_branch WHERE key = $1 AND lixcol_branch_id = $2 LIMIT 1"
		) {
			return result(
				this.reviewStore ? [[{ kind: "json", value: this.reviewStore }]] : [],
			);
		}
		if (sql.startsWith("INSERT INTO lix_key_value_by_branch")) {
			const key = textParam(params[0]);
			const value = params[1];
			assert.equal(value?.kind, "json");
			assert.match(key, /^atelier_agent_turn_commit_range:/);
			if (!this.normalizedReviewRanges.has(key)) {
				this.normalizedReviewRanges.set(
					key,
					value.value as Record<string, unknown>,
				);
			}
			return result([], 1);
		}

		if (
			sql ===
			"SELECT data, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE path = $1"
		) {
			const path = textParam(params[0]);
			const file = this.files.get(path);
			return result(
				file
					? [
							[
								blobValue(file.bytes),
								textValue(file.revision),
								textValue(UPDATED_AT),
							],
						]
					: [],
			);
		}
		if (sql === "SELECT id FROM lix_file WHERE path = $1") {
			const path = textParam(params[0]);
			return result(this.files.has(path) ? [[textValue(`file:${path}`)]] : []);
		}
		if (sql === "SELECT id FROM lix_directory WHERE path = $1") {
			const directory = this.directories.get(textParam(params[0]));
			return result(directory ? [[textValue(directory.id)]] : []);
		}
		if (
			sql ===
			"INSERT INTO lix_file (path, data, lixcol_metadata) VALUES ($1, $2, $3)"
		) {
			const path = textParam(params[0]);
			if (this.files.has(path)) throw new Error("duplicate path");
			this.files.set(path, {
				bytes: blobParam(params[1]),
				revision: this.nextRevision(),
			});
			return result([], 1);
		}
		if (
			sql ===
			"UPDATE lix_file SET data = $1, lixcol_metadata = $2 WHERE path = $3 AND lixcol_change_id = $4"
		) {
			const path = textParam(params[2]);
			const expected = textParam(params[3]);
			const file = this.files.get(path);
			if (!file || file.revision !== expected) return result([], 0);
			file.bytes = blobParam(params[0]);
			file.revision = this.nextRevision();
			return result([], 1);
		}
		if (sql === "INSERT INTO lix_directory (path) VALUES ($1)") {
			const path = textParam(params[0]);
			this.directories.set(path, {
				id: `dir:${path}`,
				revision: this.nextRevision(),
			});
			return result([], 1);
		}
		if (sql.startsWith("UPDATE lix_file SET path = $1")) {
			return this.move(this.files, params);
		}
		if (sql.startsWith("UPDATE lix_directory SET path = $1")) {
			return this.move(this.directories, params);
		}
		if (sql.startsWith("DELETE FROM lix_file WHERE path = $1")) {
			return this.delete(this.files, params, false);
		}
		if (sql.startsWith("DELETE FROM lix_directory WHERE path = $1")) {
			return this.delete(this.directories, params, true);
		}
		if (
			sql.startsWith(
				"SELECT path, name, lixcol_metadata, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE",
			)
		) {
			const pattern = textParam(params[0]);
			const needle = pattern.slice(1, -1).toLowerCase();
			const lowerBound = params[1] ? textParam(params[1]) : undefined;
			const upperBound = params[2] ? textParam(params[2]) : undefined;
			const rows = [...this.files.entries()]
				.filter(
					([path]) =>
						path.toLowerCase().includes(needle) &&
						(lowerBound === undefined || path >= lowerBound) &&
						(upperBound === undefined || path < upperBound),
				)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([path, file]) => [
					textValue(path),
					textValue(nameFromPath(path)),
					{ kind: "json" as const, value: { size: file.bytes.length } },
					textValue(file.revision),
					textValue(UPDATED_AT),
				]);
			return result(rows);
		}
		if (
			sql.startsWith(
				"SELECT path, name, lixcol_change_id, lixcol_updated_at, lixcol_metadata",
			)
		) {
			return this.entrySummary(this.files, textParam(params[0]), true);
		}
		if (
			sql.startsWith("SELECT path, name, lixcol_change_id, lixcol_updated_at")
		) {
			return this.entrySummary(this.directories, textParam(params[0]), false);
		}

		throw new Error(`Unsupported test SQL: ${sql}`);
	}

	async executeScript(
		workspaceId: string,
		request: ExecuteRequest,
	): Promise<ExecuteScriptResponse> {
		return { results: [await this.execute(workspaceId, request)] };
	}

	async mutate(
		_workspaceId: string,
		request: FilesystemMutationRequest,
	): Promise<FilesystemMutationOutcome> {
		assert.equal(request.branchId, BRANCH_ID);
		const entries = request.kind === "file" ? this.files : this.directories;
		const entry = entries.get(request.path);
		if (!entry || entry.revision !== request.expectedRevision) {
			return "conflict";
		}

		switch (request.mutation.type) {
			case "replace_file": {
				assert.equal(request.kind, "file");
				const file = entry as StoredFile;
				file.bytes = blobParam(request.mutation.data);
				file.revision = this.nextRevision();
				return "applied";
			}
			case "move": {
				if (this.entryExists(request.mutation.destinationPath)) {
					return "already_exists";
				}
				entries.delete(request.path);
				const moved = { ...entry, revision: this.nextRevision() };
				if (request.kind === "file") {
					this.files.set(request.mutation.destinationPath, moved as StoredFile);
				} else {
					this.directories.set(
						request.mutation.destinationPath,
						moved as StoredDirectory,
					);
				}
				return "applied";
			}
			case "delete":
				entries.delete(request.path);
				if (request.kind === "directory") {
					for (const filePath of this.files.keys()) {
						if (filePath.startsWith(request.path)) this.files.delete(filePath);
					}
					for (const directoryPath of this.directories.keys()) {
						if (directoryPath.startsWith(request.path)) {
							this.directories.delete(directoryPath);
						}
					}
				}
				return "applied";
		}
	}

	private entryExists(path: string): boolean {
		const filePath = path.endsWith("/") ? path.slice(0, -1) : path;
		return this.files.has(filePath) || this.directories.has(`${filePath}/`);
	}

	private entrySummary(
		entries: Map<string, StoredFile | StoredDirectory>,
		path: string,
		includeMetadata: boolean,
	): ExecuteResponse {
		const entry = entries.get(path);
		if (!entry) return result([]);
		const row: Array<WireValue> = [
			textValue(path),
			textValue(nameFromPath(path)),
			textValue(entry.revision),
			textValue(UPDATED_AT),
		];
		if (includeMetadata) {
			row.push({
				kind: "json",
				value: { size: (entry as StoredFile).bytes.length },
			});
		}
		return result([row]);
	}

	private move<T extends StoredFile | StoredDirectory>(
		entries: Map<string, T>,
		params: Array<WireValue>,
	): ExecuteResponse {
		const destination = textParam(params[0]);
		const source = textParam(params[1]);
		const expected = textParam(params[2]);
		const entry = entries.get(source);
		if (!entry || entry.revision !== expected) return result([], 0);
		entries.delete(source);
		entries.set(destination, { ...entry, revision: this.nextRevision() });
		return result([], 1);
	}

	private delete<T extends StoredFile | StoredDirectory>(
		entries: Map<string, T>,
		params: Array<WireValue>,
		recursive: boolean,
	): ExecuteResponse {
		const path = textParam(params[0]);
		const expected = textParam(params[1]);
		const entry = entries.get(path);
		if (!entry || entry.revision !== expected) return result([], 0);
		entries.delete(path);
		if (recursive) {
			for (const filePath of this.files.keys()) {
				if (filePath.startsWith(path)) this.files.delete(filePath);
			}
			for (const directoryPath of this.directories.keys()) {
				if (directoryPath.startsWith(path))
					this.directories.delete(directoryPath);
			}
		}
		return result([], 1);
	}

	private observeRevision(revision: string): void {
		const match = /^rev-(\d+)$/.exec(revision);
		if (match)
			this.revisionCounter = Math.max(this.revisionCounter, Number(match[1]));
	}

	private nextRevision(): string {
		this.revisionCounter += 1;
		return `rev-${this.revisionCounter}`;
	}
}

const UPDATED_AT = "2026-07-10T12:00:00.000Z";

function result(
	rows: Array<Array<WireValue>>,
	rowsAffected = 0,
): ExecuteResponse {
	return { columns: [], rows, rowsAffected, notices: [] };
}

function textValue(value: string): WireValue {
	return { kind: "text", value };
}

function blobValue(bytes: Uint8Array): WireValue {
	return { kind: "blob", base64: Buffer.from(bytes).toString("base64") };
}

function textParam(value: WireValue | undefined): string {
	assert.ok(value?.kind === "text");
	return value.value;
}

function blobParam(value: WireValue | undefined): Uint8Array {
	assert.ok(value?.kind === "blob");
	return new Uint8Array(Buffer.from(value.base64, "base64"));
}

function nameFromPath(path: string): string {
	const withoutSuffix = path.endsWith("/") ? path.slice(0, -1) : path;
	return withoutSuffix.slice(withoutSuffix.lastIndexOf("/") + 1);
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof FileServiceError && error.code === code;
}
