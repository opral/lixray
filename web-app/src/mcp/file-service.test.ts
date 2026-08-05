import assert from "node:assert/strict";
import test from "node:test";
import {
	FileServiceError,
	LixFileService,
	MAX_PATH_LENGTH,
	MAX_TEXT_FILE_BYTES,
	directoryPath,
	filePath,
	type ExecuteBatchRequest,
	type ExecuteRequest,
	type ExecuteResponse,
	type ExecuteScriptResponse,
	type LixRuntimeClient,
	type LixSummary,
	type WireValue,
} from "./file-service.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LIX_ID = "22222222-2222-4222-8222-222222222222";
const UUID_SLUG_LIX_ID = "33333333-3333-4333-8333-333333333333";
const BRANCH_ID = "main";

void test("lix refs resolve UUIDs, unique slugs, and qualified slugs", async () => {
	const client = new MemoryLixRuntimeClient();
	client.lixSummaries.push({
		id: OTHER_LIX_ID,
		name: "Other personal",
		slug: "personal",
		namespace: { id: "org-2", name: "Other", handle: "other" },
	});
	client.lixSummaries.push({
		id: UUID_SLUG_LIX_ID,
		name: "UUID slug",
		slug: LIX_ID,
		namespace: { id: "org-3", name: "UUID Slugs", handle: "uuid-slugs" },
	});
	const service = new LixFileService(client);

	assert.equal(await service.resolveLixRef(LIX_ID), LIX_ID);
	assert.equal(
		await service.resolveLixRef(`@uuid-slugs/${LIX_ID}`),
		UUID_SLUG_LIX_ID,
	);
	assert.equal(await service.resolveLixRef("@example/personal"), LIX_ID);
	assert.equal(await service.resolveLixRef("@other/personal"), OTHER_LIX_ID);
	await assert.rejects(
		service.resolveLixRef("personal"),
		hasCode("ambiguous_lix_ref"),
	);
	await assert.rejects(service.resolveLixRef("missing"), hasCode("not_found"));
});

void test("unique bare lix slugs resolve without discovery by the caller", async () => {
	const service = new LixFileService(new MemoryLixRuntimeClient());
	assert.equal(await service.resolveLixRef("personal"), LIX_ID);
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

void test("active branch methods delegate directly to the Lix client", async () => {
	let activeBranchCalls = 0;
	const switches: Array<{ lixId: string; branchId: string }> = [];
	const service = new LixFileService({
		listLixes: async () => [],
		activeBranchId: async (lixId) => {
			activeBranchCalls += 1;
			assert.equal(lixId, LIX_ID);
			return "active-branch";
		},
		switchBranch: async (lixId, branchId) => {
			switches.push({ lixId, branchId });
			return { branchId };
		},
		execute: async () => result([]),
		executeBatch: async () => ({ results: [] }),
	});

	assert.equal(await service.activeBranchId(LIX_ID), "active-branch");
	assert.deepEqual(await service.switchBranch(LIX_ID, "draft"), {
		branchId: "draft",
	});
	assert.equal(activeBranchCalls, 1);
	assert.deepEqual(switches, [{ lixId: LIX_ID, branchId: "draft" }]);
});

void test("list_directory maps one ordered root read", async () => {
	const requests: Array<ExecuteRequest> = [];
	const service = new LixFileService(
		testRuntimeClient((request) => {
			requests.push(request);
			return result([
				[
					{ kind: "int", value: 0 },
					textValue("/docs/"),
					textValue("docs"),
					{ kind: "json", value: null },
					textValue("dir-rev"),
					textValue(UPDATED_AT),
				],
				[
					{ kind: "int", value: 1 },
					textValue("/README.md"),
					textValue("README.md"),
					{ kind: "json", value: { size: 42 } },
					textValue("file-rev"),
					textValue(UPDATED_AT),
				],
			]);
		}),
	);

	assert.deepEqual(await service.listDirectory(LIX_ID, "/"), [
		{
			kind: "directory",
			path: "/docs/",
			name: "docs",
			changeId: "dir-rev",
			updatedAt: UPDATED_AT,
		},
		{
			kind: "file",
			path: "/README.md",
			name: "README.md",
			size: 42,
			changeId: "file-rev",
			updatedAt: UPDATED_AT,
		},
	]);

	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.ok(request);
	assert.deepEqual(request.params, []);
	assert.match(request.sql, /lix_json\('null'\) AS lixcol_metadata/);
	assert.match(request.sql, /lix_directory WHERE parent_id IS NULL/);
	assert.match(request.sql, /lix_file WHERE directory_id IS NULL/);
	assert.match(request.sql, /UNION ALL/);
	assert.match(request.sql, /ORDER BY entry_kind, name$/);
});

void test("list_directory reuses the resolved directory id in one ordered read", async () => {
	const requests: Array<ExecuteRequest> = [];
	const service = new LixFileService(
		testRuntimeClient((request) => {
			requests.push(request);
			if (request.sql === "SELECT id FROM lix_directory WHERE path = $1") {
				return result([[textValue("docs-id")]]);
			}
			return result([
				[
					{ kind: "int", value: 0 },
					textValue("/docs/guides/"),
					textValue("guides"),
					{ kind: "json", value: null },
					textValue("guides-rev"),
					textValue(UPDATED_AT),
				],
				[
					{ kind: "int", value: 1 },
					textValue("/docs/readme.md"),
					textValue("readme.md"),
					{ kind: "json", value: { size: 7 } },
					textValue("readme-rev"),
					textValue(UPDATED_AT),
				],
			]);
		}),
	);

	assert.deepEqual(await service.listDirectory(LIX_ID, "/docs/"), [
		{
			kind: "directory",
			path: "/docs/guides/",
			name: "guides",
			changeId: "guides-rev",
			updatedAt: UPDATED_AT,
		},
		{
			kind: "file",
			path: "/docs/readme.md",
			name: "readme.md",
			size: 7,
			changeId: "readme-rev",
			updatedAt: UPDATED_AT,
		},
	]);

	assert.equal(requests.length, 2);
	const request = requests[1];
	assert.ok(request);
	assert.deepEqual(request.params, [{ kind: "text", value: "docs-id" }]);
	assert.match(request.sql, /lix_directory WHERE parent_id = \$1/);
	assert.match(request.sql, /lix_file WHERE directory_id = \$1/);
	assert.match(request.sql, /ORDER BY entry_kind, name$/);
});

void test("entry existence checks use one selective union read", async () => {
	const requests: Array<ExecuteRequest> = [];
	const service = new LixFileService(
		testRuntimeClient((request) => {
			requests.push(request);
			return result([[textValue("file:/taken")]]);
		}),
	);

	await assert.rejects(
		service.createDirectory(LIX_ID, "/taken/"),
		hasCode("already_exists"),
	);

	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.ok(request);
	assert.equal(
		request.sql,
		"SELECT id FROM lix_file WHERE path = $1 UNION ALL SELECT id FROM lix_directory WHERE path = $2",
	);
	assert.deepEqual(request.params, [
		{ kind: "text", value: "/taken" },
		{ kind: "text", value: "/taken/" },
	]);
});

void test("entry existence detects a directory at a file path", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addDirectory("/taken/", "rev-1");
	const service = new LixFileService(client);

	await assert.rejects(
		service.writeFile(LIX_ID, "/taken", "content"),
		hasCode("already_exists"),
	);
});

void test("read_file validates UTF-8 and paginates by line with a change ID", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile(
		"/notes.txt",
		new TextEncoder().encode("one\ntwo\nthree"),
		"rev-7",
	);
	const service = new LixFileService(client);

	const page = await service.readFile(LIX_ID, "/notes.txt", 2, 1);
	assert.deepEqual(page, {
		path: "/notes.txt",
		content: "two",
		size: 13,
		changeId: "rev-7",
		updatedAt: "2026-07-10T12:00:00.000Z",
		totalLines: 3,
		startLine: 2,
		endLine: 2,
		hasMore: true,
	});

	client.addFile("/binary.dat", new Uint8Array([0xc3, 0x28]), "rev-1");
	await assert.rejects(
		service.readFile(LIX_ID, "/binary.dat"),
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
		service.readFile(LIX_ID, "/large.txt"),
		hasCode("file_too_large"),
	);
	await assert.rejects(
		service.writeFile(
			LIX_ID,
			"/too-large.txt",
			"x".repeat(MAX_TEXT_FILE_BYTES + 1),
		),
		hasCode("file_too_large"),
	);
});

void test("write_file overwrites the current file and supports internal compare-and-swap", async () => {
	const client = new MemoryLixRuntimeClient();
	const service = new LixFileService(client);

	const created = await service.writeFile(LIX_ID, "/new.txt", "first");
	assert.equal(created.path, "/new.txt");
	assert.equal(created.changeId, "rev-1");
	const overwritten = await service.writeFile(LIX_ID, "/new.txt", "overwrite");
	assert.equal(overwritten.changeId, "rev-2");
	assert.equal(client.fileText("/new.txt"), "overwrite");
	await assert.rejects(
		service.writeFile(LIX_ID, "/new.txt", "overwrite", "stale"),
		hasCode("conflict"),
	);

	const replaced = await service.writeFile(
		LIX_ID,
		"/new.txt",
		"second",
		overwritten.changeId,
	);
	assert.equal(replaced.changeId, "rev-3");
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

	const files = await service.findFiles(LIX_ID, "match-");
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
		service.editFile(LIX_ID, "/edit.txt", "rev-3", [
			{ oldText: "red", newText: "green" },
		]),
		hasCode("invalid_edit"),
	);
	await assert.rejects(
		service.editFile(LIX_ID, "/edit.txt", "stale", [
			{ oldText: "blue", newText: "cyan" },
		]),
		hasCode("conflict"),
	);

	const edited = await service.editFile(LIX_ID, "/edit.txt", "rev-3", [
		{ oldText: "red", newText: "green", replaceAll: true },
		{ oldText: "blue", newText: "cyan" },
	]);
	assert.equal(edited.changeId, "rev-4");
	assert.equal(client.fileText("/edit.txt"), "green green cyan");

	const editedWithoutChangeId = await service.editFile(
		LIX_ID,
		"/edit.txt",
		undefined,
		[{ oldText: "cyan", newText: "blue" }],
	);
	assert.equal(editedWithoutChangeId.changeId, "rev-5");
	assert.equal(client.fileText("/edit.txt"), "green green blue");
});

void test("edit_file treats replacement text literally", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/literal.txt", new TextEncoder().encode("before"), "rev-1");
	const service = new LixFileService(client);
	const replacement = "$$$ profits $& $` $' $1";

	await service.editFile(LIX_ID, "/literal.txt", "rev-1", [
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

	await service.editFile(LIX_ID, "/review.md", "rev-3", [
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

	await service.writeFile(LIX_ID, "/created-by-agent.md", "created");

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

void test("move_entry never overwrites and accepts an omitted source change ID", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addFile("/source.txt", new TextEncoder().encode("source"), "rev-4");
	client.addFile("/taken.txt", new TextEncoder().encode("taken"), "rev-2");
	const service = new LixFileService(client);

	await assert.rejects(
		service.moveEntry(LIX_ID, "/source.txt", "/taken.txt", "rev-4"),
		hasCode("already_exists"),
	);
	await assert.rejects(
		service.moveEntry(LIX_ID, "/source.txt", "/renamed.txt", "stale"),
		hasCode("conflict"),
	);

	const moved = await service.moveEntry(
		LIX_ID,
		"/source.txt",
		"/renamed.txt",
		undefined,
	);
	assert.equal(moved.path, "/renamed.txt");
	assert.equal(client.fileText("/renamed.txt"), "source");
	assert.equal(client.hasFile("/source.txt"), false);
});

void test("directory deletion requires recursive confirmation and accepts an omitted change ID", async () => {
	const client = new MemoryLixRuntimeClient();
	client.addDirectory("/docs/", "rev-9");
	client.addFile("/docs/readme.md", new TextEncoder().encode("hello"), "rev-1");
	const service = new LixFileService(client);

	await assert.rejects(
		service.deleteEntry(LIX_ID, "/docs/", "rev-9"),
		hasCode("recursive_required"),
	);
	await assert.rejects(
		service.deleteEntry(LIX_ID, "/docs/", "stale", true),
		hasCode("conflict"),
	);
	assert.deepEqual(
		await service.deleteEntry(LIX_ID, "/docs/", undefined, true),
		{ path: "/docs/", deleted: true },
	);
	assert.equal(client.hasFile("/docs/readme.md"), false);
});

type StoredFile = { bytes: Uint8Array; changeId: string };
type StoredDirectory = { changeId: string; id: string };

function testRuntimeClient(
	execute: (
		request: ExecuteRequest,
	) => ExecuteResponse | Promise<ExecuteResponse>,
): LixRuntimeClient {
	return {
		listLixes: async () => [],
		activeBranchId: async () => BRANCH_ID,
		switchBranch: async (_lixId, branchId) => ({ branchId }),
		execute: async (_lixId, request) => execute(request),
		executeBatch: async () => {
			throw new Error("listDirectory must use execute, not executeBatch");
		},
	};
}

class MemoryLixRuntimeClient implements LixRuntimeClient {
	readonly lixSummaries: Array<LixSummary> = [
		{
			id: LIX_ID,
			name: "Personal",
			slug: "personal",
			namespace: { id: "org-1", name: "Example", handle: "example" },
		},
	];
	private readonly files = new Map<string, StoredFile>();
	private readonly directories = new Map<string, StoredDirectory>();
	private changeCounter = 0;
	private activeBranch = BRANCH_ID;
	private readonly normalizedReviewRanges = new Map<
		string,
		Record<string, unknown>
	>();

	addFile(path: string, bytes: Uint8Array, changeId: string): void {
		this.files.set(path, { bytes, changeId });
		this.observeChangeId(changeId);
	}

	addDirectory(path: string, changeId: string): void {
		this.directories.set(path, { changeId, id: `dir:${path}` });
		this.observeChangeId(changeId);
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

	async listLixes() {
		return this.lixSummaries.map((lix) => ({
			...lix,
			namespace: { ...lix.namespace },
		}));
	}

	async activeBranchId(): Promise<string> {
		return this.activeBranch;
	}

	async switchBranch(
		_lixId: string,
		branchId: string,
	): Promise<{ branchId: string }> {
		this.activeBranch = branchId;
		return { branchId };
	}

	async execute(
		_lixId: string,
		request: ExecuteRequest,
	): Promise<ExecuteResponse> {
		const sql = request.sql;
		const params = request.params ?? [];

		if (sql === "SELECT lix_active_branch_commit_id()") {
			return result([[textValue(`commit-${this.changeCounter}`)]]);
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
			"SELECT content, lixcol_change_id, lixcol_updated_at FROM lix_file WHERE path = $1"
		) {
			const path = textParam(params[0]);
			const file = this.files.get(path);
			return result(
				file
					? [
							[
								blobValue(file.bytes),
								textValue(file.changeId),
								textValue(UPDATED_AT),
							],
						]
					: [],
			);
		}
		if (
			sql ===
			"SELECT id FROM lix_file WHERE path = $1 UNION ALL SELECT id FROM lix_directory WHERE path = $2"
		) {
			const path = textParam(params[0]);
			const directory = this.directories.get(textParam(params[1]));
			return result([
				...(this.files.has(path) ? [[textValue(`file:${path}`)]] : []),
				...(directory ? [[textValue(directory.id)]] : []),
			]);
		}
		if (
			sql ===
			"INSERT INTO lix_file (path, content, lixcol_metadata) VALUES ($1, $2, $3)"
		) {
			const path = textParam(params[0]);
			if (this.files.has(path)) throw new Error("duplicate path");
			this.files.set(path, {
				bytes: blobParam(params[1]),
				changeId: this.nextChangeId(),
			});
			return result([], 1);
		}
		if (
			sql ===
			"UPDATE lix_file SET content = $1, lixcol_metadata = $2 WHERE path = $3 AND lixcol_change_id = $4"
		) {
			const path = textParam(params[2]);
			const expected = textParam(params[3]);
			const file = this.files.get(path);
			if (!file || file.changeId !== expected) return result([], 0);
			file.bytes = blobParam(params[0]);
			file.changeId = this.nextChangeId();
			return result([], 1);
		}
		if (sql === "INSERT INTO lix_directory (path) VALUES ($1)") {
			const path = textParam(params[0]);
			this.directories.set(path, {
				id: `dir:${path}`,
				changeId: this.nextChangeId(),
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
					textValue(file.changeId),
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

	async executeBatch(
		lixId: string,
		request: ExecuteBatchRequest,
	): Promise<ExecuteScriptResponse> {
		const results: Array<ExecuteResponse> = [];
		for (const statement of request.statements) {
			results.push(
				await this.execute(lixId, {
					...statement,
					options: request.options,
				}),
			);
		}
		return { results };
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
			textValue(entry.changeId),
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
		if (!entry || entry.changeId !== expected) return result([], 0);
		if (
			(params[3] && this.files.has(textParam(params[3]))) ||
			(params[4] && this.directories.has(textParam(params[4])))
		) {
			return result([], 0);
		}
		entries.delete(source);
		entries.set(destination, { ...entry, changeId: this.nextChangeId() });
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
		if (!entry || entry.changeId !== expected) return result([], 0);
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

	private observeChangeId(changeId: string): void {
		const match = /^rev-(\d+)$/.exec(changeId);
		if (match)
			this.changeCounter = Math.max(this.changeCounter, Number(match[1]));
	}

	private nextChangeId(): string {
		this.changeCounter += 1;
		return `rev-${this.changeCounter}`;
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
