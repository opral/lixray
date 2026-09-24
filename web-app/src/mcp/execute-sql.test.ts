/**
 * execute_sql as the one write path, against the real Lix engine.
 *
 * Everything below the MCP client is production code — the server, the
 * service, the runtime client's transaction and retry — over an in-memory
 * Lix instead of the remote server. The guard is only as good as what a
 * transaction's reads see, so that is proven first, on the engine itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openLix, type Lix } from "@lix-js/sdk";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { DIFF_CARD_META } from "./diff-card-app.ts";
import type { DiffCardPayload } from "./diff-card.ts";
import {
	LixService,
	type TransactionClient,
	type WireValue,
} from "./lix-service.ts";
import { WorkerLixRuntimeClient } from "./runtime-client.ts";
import { handleMcpTransport, MCP_PROTOCOL_VERSION } from "./server.ts";
import { BINARY_CONTENT_HINT, NAMESPACE_CONFLICT_HINT } from "./sql-errors.ts";

const LIX_ID = "11111111-1111-4111-8111-111111111111";
const LIX_REF = "@acme/company";
const UPSERT =
	"INSERT INTO lix_file (path, content) VALUES ($1, CAST($2 AS BYTEA)) ON CONFLICT (path) DO UPDATE SET content = excluded.content";
const MOVE = "UPDATE lix_file SET path = $1 WHERE path = $2";
const MCP_DOCS = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../../docs/mcp.md"),
	"utf8",
);

const text = (value: string): WireValue => ({ kind: "text", value });
const upsert = (path: string, content: string) => ({
	sql: UPSERT,
	params: [text(path), text(content)],
});
const move = (to: string, from: string) => ({
	sql: MOVE,
	params: [text(to), text(from)],
});

type Runtime = WorkerLixRuntimeClient;

/** A runtime whose one Lix is `lix`, and an MCP client in front of it. */
async function connect(
	lix: Lix,
	makeRuntime: (lix: Lix) => Runtime = runtimeFor,
): Promise<{
	runtime: Runtime;
	client: Client;
	call: (name: string, args: Record<string, unknown>) => Promise<CallResult>;
	close: () => Promise<void>;
}> {
	const runtime = makeRuntime(lix);
	const service = new LixService(runtime, {
		contextSigningKey: "execute-sql",
		principal: { userId: "user", clientId: "client" },
	});
	const client = new Client(
		{ name: "execute-sql-test", version: "1" },
		{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://lixray.test/mcp"), {
			fetch: (input, init) =>
				handleMcpTransport(new Request(input, init), service, {
					authMode: "none",
				}),
		}),
	);
	return {
		runtime,
		client,
		call: async (name, args) =>
			(await client.callTool({ name, arguments: args })) as CallResult,
		close: async () => {
			await client.close();
			await runtime.close();
		},
	};
}

function runtimeFor(lix: Lix): Runtime {
	return new WorkerLixRuntimeClient(
		{},
		{ userId: "user", token: "local" },
		async () => null,
		{
			lixSummaries: [
				{
					id: LIX_ID,
					name: "Company",
					slug: "company",
					namespace: { id: LIX_ID, name: "Acme", handle: "acme" },
				},
			],
			openLix: async () => lix,
		},
	);
}

type CallResult = {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content?: Array<{ type: string; text?: string }>;
	_meta?: Record<string, unknown>;
};

type ToolError = {
	code: string;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
	statement_index?: number;
	outcome?: string;
};

function errorOf(result: CallResult): ToolError {
	assert.equal(result.isError, true, JSON.stringify(result));
	const json = (result.content ?? [])
		.map((block) => block.text ?? "")
		.find((block) => block.startsWith("{"));
	assert.ok(json, "an error carries its JSON text block");
	return (JSON.parse(json) as { error: ToolError }).error;
}

function ok(result: CallResult): Record<string, unknown> {
	assert.equal(result.isError, undefined, JSON.stringify(result));
	return result.structuredContent!;
}

async function head(lix: Lix): Promise<string> {
	const result = await lix.execute(
		"SELECT lix_active_branch_commit_id() AS id",
	);
	return result.rows[0]!.id as string;
}

async function files(
	lix: Lix,
): Promise<Map<string, { id: string; content: string }>> {
	const result = await lix.execute(
		"SELECT id, path, content FROM lix_file WHERE path NOT LIKE '/.lix/%'",
	);
	return new Map(
		result.rows.map((row) => [
			row.path as string,
			{
				id: row.id as string,
				content: new TextDecoder().decode(row.content as Uint8Array),
			},
		]),
	);
}

async function seed(lix: Lix, entries: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(entries))
		await lix.execute(UPSERT, [path, content]);
}

void test("reads inside a transaction see the transaction's own writes", async () => {
	const lix = await openLix({});
	const runtime = runtimeFor(lix);
	try {
		await seed(lix, { "/notes.md": "before", "/gone.md": "gone" });
		const committed = await head(lix);
		const ids = await files(lix);
		const notesId = ids.get("/notes.md")!.id;
		const goneId = ids.get("/gone.md")!.id;
		const rollback = new Error("roll back");
		const read = async (
			tx: TransactionClient,
			sql: string,
			params: WireValue[] = [],
		) => (await tx.execute({ sql, params })).rows;
		await assert.rejects(
			runtime.transaction(LIX_ID, await lix.activeBranchId(), async (tx) => {
				await tx.execute(upsert("/new.md", "created"));
				await tx.execute(move("/archive/notes.md", "/notes.md"));
				await tx.execute(upsert("/archive/notes.md", "after"));
				await tx.execute({
					sql: "DELETE FROM lix_file WHERE path = $1",
					params: [text("/gone.md")],
				});
				// The current rows are the transaction's: created, moved with
				// its id, rewritten, deleted — and a directory it implied.
				assert.deepEqual(
					await read(
						tx,
						"SELECT path, CAST(content AS TEXT) AS c FROM lix_file WHERE path = $1",
						[text("/new.md")],
					),
					[[text("/new.md"), text("created")]],
				);
				assert.deepEqual(
					await read(
						tx,
						"SELECT path, CAST(content AS TEXT) AS c FROM lix_file WHERE id = $1",
						[text(notesId)],
					),
					[[text("/archive/notes.md"), text("after")]],
				);
				assert.deepEqual(
					await read(tx, "SELECT id FROM lix_file WHERE id = $1", [
						text(goneId),
					]),
					[],
				);
				assert.equal(
					(
						await read(tx, "SELECT id FROM lix_directory WHERE path = $1", [
							text("/archive"),
						])
					).length,
					1,
				);
				// The head is still the committed state, and still says so.
				assert.deepEqual(
					await read(tx, "SELECT lix_active_branch_commit_id()"),
					[[text(committed)]],
				);
				assert.deepEqual(
					await read(
						tx,
						"SELECT path, CAST(content AS TEXT) AS c FROM lix_as_of('lix_file', $1) WHERE id IN ($2, $3) ORDER BY path",
						[text(committed), text(notesId), text(goneId)],
					),
					[
						[text("/gone.md"), text("gone")],
						[text("/notes.md"), text("before")],
					],
				);
				throw rollback;
			}),
			// The runtime hands errors back as LixErrors; the message survives.
			(error: unknown) => (error as Error).message === rollback.message,
		);
		// Nothing of it was committed.
		assert.equal(await head(lix), committed);
		assert.deepEqual([...(await files(lix)).keys()].sort(), [
			"/gone.md",
			"/notes.md",
		]);
	} finally {
		await runtime.close();
	}
});

void test("the documented consolidation runs as one guarded, checkpointed batch", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, {
			"/gtm/plan.md": "# Plan\n",
			"/gtm/a.md": "# A\n",
			"/gtm/b.md": "# B\n",
		});
		const before = await files(lix);
		const opened = ok(await call("open_lix", { lix_ref: LIX_REF }));
		// The worked example in docs/mcp.md, exactly as written there.
		const example = JSON.parse(
			/## Writing files[\s\S]*?```json\n([\s\S]*?)\n```/.exec(MCP_DOCS)![1]!,
		) as Record<string, unknown>;
		example.last_seen_commit_id = opened.commit_id;
		const result = await call("execute_sql", example);
		const receipt = ok(result);

		const after = await files(lix);
		// Moves keep the id, so links to them survive; parents were created.
		assert.equal(
			after.get("/gtm/archive/a.md")?.id,
			before.get("/gtm/a.md")!.id,
		);
		assert.equal(
			after.get("/gtm/archive/b.md")?.id,
			before.get("/gtm/b.md")!.id,
		);
		assert.equal(after.get("/gtm/plan.md")?.id, before.get("/gtm/plan.md")!.id);
		assert.match(after.get("/gtm/plan.md")!.content, /Merged from a\.md/);
		assert.match(after.get("/gtm/a.md")!.content, /Moved to/);
		assert.notEqual(after.get("/gtm/a.md")!.id, before.get("/gtm/a.md")!.id);
		assert.equal(after.has("/gtm/b.md"), false);

		// One commit for the batch, then the checkpoint on top of it.
		const commit = receipt.commit as { before: string; after: string };
		assert.equal(commit.before, opened.commit_id);
		const checkpoint = receipt.checkpoint_commit_id as string;
		assert.equal(checkpoint, await head(lix));
		const log = await lix.execute(
			"SELECT is_checkpoint FROM lix_log() WHERE commit_id = $1",
			[checkpoint],
		);
		assert.equal(log.rows[0]?.is_checkpoint, true);
		assert.equal(receipt.warning, undefined);
		const summary = result.content?.[0]?.text ?? "";
		assert.match(summary, /checkpoint /);

		// The card renders from the batch's receipt, moves included.
		const card = result._meta?.[DIFF_CARD_META] as DiffCardPayload | undefined;
		assert.ok(card, "a guarded batch still gets its card");
		assert.deepEqual(card.files.map((file) => file.path).sort(), [
			"/gtm/a.md",
			"/gtm/archive/a.md",
			"/gtm/archive/b.md",
			"/gtm/plan.md",
		]);
	} finally {
		await close();
	}
});

void test("a failed statement rolls back the batch and names its index on both paths", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, { "/a.md": "a", "/b.md": "b" });
		const seen = await head(lix);
		for (const guard of [{}, { last_seen_commit_id: seen }]) {
			const failed = errorOf(
				await call("execute_sql", {
					lix_ref: LIX_REF,
					...guard,
					statements: [upsert("/created.md", "x"), move("/b.md", "/a.md")],
				}),
			);
			assert.equal(failed.code, "LIX_ERROR_UNIQUE");
			assert.equal(failed.statement_index, 1);
			assert.equal(failed.outcome, "not_committed");
			assert.equal(failed.message, "Destination /b.md already exists (file).");
			assert.match(
				failed.hint ?? "",
				new RegExp(NAMESPACE_CONFLICT_HINT.replace(/[.;]/g, "\\$&")),
			);
			assert.equal(await head(lix), seen);
			assert.equal((await files(lix)).has("/created.md"), false);
		}
	} finally {
		await close();
	}
});

void test("errors name the destination path and the BYTEA binding", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, { "/gtm/b.md": "b", "/gtm/archive/b.md": "archived" });
		// A parent that exists is looked up by id.
		const nested = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [move("/gtm/archive/b.md", "/gtm/b.md")],
			}),
		);
		assert.equal(
			nested.message,
			"Destination /gtm/archive/b.md already exists (file).",
		);
		assert.doesNotMatch(nested.message, /[0-9a-f]{8}-[0-9a-f]{4}/);
		// A directory onto a directory, at the root.
		const directory = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					{
						sql: "UPDATE lix_directory SET path = $1 WHERE path = $2",
						params: [text("/gtm"), text("/gtm/archive")],
					},
				],
			}),
		);
		assert.equal(
			directory.message,
			"Destination /gtm already exists (directory).",
		);
		// A parent the rolled-back batch created is named from its parameters.
		const created = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					upsert("/fresh/b.md", "new"),
					move("/fresh/b.md", "/gtm/b.md"),
				],
			}),
		);
		assert.equal(created.statement_index, 1);
		assert.equal(
			created.message,
			"Destination /fresh/b.md already exists (file).",
		);
		// Text straight into the byte column.
		const binary = errorOf(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				statements: [
					upsert("/ok.md", "fine"),
					{
						sql: "UPDATE lix_file SET content = $1 WHERE path = $2",
						params: [text("text"), text("/gtm/b.md")],
					},
				],
			}),
		);
		assert.equal(binary.code, "LIX_TYPE_MISMATCH");
		assert.equal(binary.statement_index, 1);
		assert.match(
			binary.hint ?? "",
			/^Bind text as CAST\(\$n AS BYTEA\) with a text param\./,
		);
		assert.equal(binary.hint?.startsWith(BINARY_CONTENT_HINT), true);
		assert.equal((await files(lix)).has("/ok.md"), false);
	} finally {
		await close();
	}
});

void test("last_seen_commit_id refuses a batch that touches what changed, and only that", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, {
			"/notes.md": "ours to start",
			"/moved.md": "m",
			"/same.md": "same",
			"/gone.md": "g",
			"/free.md": "free",
		});
		await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", [
			"/empty",
		]);
		const seen = await head(lix);
		// Someone else edits, moves, deletes, and adds after we looked.
		await lix.execute(UPSERT, ["/notes.md", "their edit"]);
		await lix.execute(MOVE, ["/elsewhere/moved.md", "/moved.md"]);
		await lix.execute(UPSERT, ["/same.md", "converged"]);
		await lix.execute("DELETE FROM lix_file WHERE path = $1", ["/gone.md"]);
		await lix.execute("UPDATE lix_directory SET path = $1 WHERE path = $2", [
			"/filled",
			"/empty",
		]);
		const current = await head(lix);
		const guarded = (statements: unknown[]) =>
			call("execute_sql", {
				lix_ref: LIX_REF,
				last_seen_commit_id: seen,
				statements,
			});

		const conflict = errorOf(
			await guarded([
				upsert("/unrelated.md", "x"),
				upsert("/notes.md", "our edit"),
			]),
		);
		assert.equal(conflict.code, "conflict");
		assert.equal(conflict.outcome, "not_committed");
		assert.match(conflict.message, /\/notes\.md/);
		assert.doesNotMatch(conflict.message, /moved|same|gone|filled/);
		assert.match(
			conflict.hint ?? "",
			/last_seen_commit_id = details\.current_commit_id/,
		);
		assert.deepEqual(conflict.details, {
			current_commit_id: current,
			files: [
				{ path: "/notes.md", content: "their edit", lixcol_metadata: null },
			],
		});
		assert.equal(await head(lix), current);
		assert.equal((await files(lix)).has("/unrelated.md"), false);

		// Moving, deleting, or re-creating what others changed is touching it.
		for (const statements of [
			[move("/archive/notes.md", "/notes.md")],
			[move("/archive/moved.md", "/elsewhere/moved.md")],
			[
				{
					sql: "DELETE FROM lix_file WHERE path = $1",
					params: [text("/notes.md")],
				},
			],
			[upsert("/gone.md", "back")],
			[
				{
					sql: "DELETE FROM lix_directory WHERE path = $1",
					params: [text("/filled")],
				},
			],
		]) {
			const refused = errorOf(await guarded(statements));
			assert.equal(refused.code, "conflict", JSON.stringify(statements));
			assert.equal(await head(lix), current);
		}
		const deleted = errorOf(await guarded([upsert("/gone.md", "back")]));
		assert.match(deleted.message, /\/gone\.md \(deleted\)/);
		assert.deepEqual((deleted.details as { files: unknown[] }).files, []);
		const directory = errorOf(
			await guarded([
				{
					sql: "DELETE FROM lix_directory WHERE path = $1",
					params: [text("/filled")],
				},
			]),
		);
		assert.match(directory.message, /directory \/filled/);

		// Changes the batch leaves as they are never block: an unrelated
		// file, a no-op delete of a file already gone, content that already
		// matches, reading a changed file, a directory insert that is there.
		const unrelated = ok(
			await guarded([
				upsert("/free.md", "ours"),
				{
					sql: "DELETE FROM lix_file WHERE path = $1",
					params: [text("/gone.md")],
				},
				upsert("/same.md", "converged"),
				{
					sql: "SELECT CAST(content AS TEXT) FROM lix_file WHERE path = $1",
					params: [text("/notes.md")],
				},
				{
					sql: "INSERT INTO lix_directory (path) VALUES ($1) ON CONFLICT (path) DO NOTHING",
					params: [text("/filled")],
				},
			]),
		);
		assert.equal((unrelated.commit as { before: string }).before, current);
		assert.equal((await files(lix)).get("/free.md")?.content, "ours");

		// The head itself passes; so does any older commit when nothing the
		// batch touches changed since — but our own earlier batch counts.
		ok(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				last_seen_commit_id: await head(lix),
				statements: [upsert("/free.md", "again")],
			}),
		);
		ok(await guarded([upsert("/brand-new.md", "new")]));
		assert.equal(
			errorOf(await guarded([upsert("/free.md", "stale")])).code,
			"conflict",
		);
		// The retry the hint describes: merged, against current_commit_id.
		ok(
			await call("execute_sql", {
				lix_ref: LIX_REF,
				last_seen_commit_id: conflict.details!.current_commit_id,
				statements: [upsert("/notes.md", "merged")],
			}),
		);
		assert.equal((await files(lix)).get("/notes.md")?.content, "merged");
	} finally {
		await close();
	}
});

void test("a last_seen_commit_id Lix cannot compare is refused before anything runs", async () => {
	const lix = await openLix({});
	const { call, close } = await connect(lix);
	try {
		await seed(lix, { "/a.md": "a" });
		const seen = await head(lix);
		await seed(lix, { "/b.md": "b" });
		for (const lastSeen of [
			"not-a-commit",
			"01a0c785-4cd8-7863-9daa-047c00000009",
		]) {
			const refused = errorOf(
				await call("execute_sql", {
					lix_ref: LIX_REF,
					last_seen_commit_id: lastSeen,
					statements: [upsert("/c.md", "c")],
				}),
			);
			assert.equal(refused.code, "invalid_request", lastSeen);
			assert.equal(refused.outcome, "not_committed");
			assert.match(
				refused.message,
				/last_seen_commit_id could not be compared/,
			);
		}
		assert.equal((await files(lix)).has("/c.md"), false);
		assert.notEqual(await head(lix), seen);
	} finally {
		await close();
	}
});

for (const concurrentPath of ["/target.md", "/unrelated.md"]) {
	void test(`a concurrent commit replays the guarded batch, guard included (${concurrentPath})`, async () => {
		const lix = await openLix({});
		/**
		 * A definite commit conflict discards the attempt and runs the whole
		 * callback again on the new head. This runtime does that once: it runs
		 * the callback, rolls it back, lets someone else commit, and replays.
		 */
		class ReplayingRuntime extends WorkerLixRuntimeClient {
			attempts = 0;
			override async transaction<T>(
				lixId: string,
				branchId: string,
				run: (tx: TransactionClient) => Promise<T>,
			) {
				const discarded = new Error("discarded attempt");
				await assert.rejects(
					super.transaction(lixId, branchId, async (tx) => {
						this.attempts++;
						await run(tx);
						throw discarded;
					}),
					(error: unknown) => (error as Error).message === discarded.message,
				);
				await lix.execute(UPSERT, [concurrentPath, "concurrent edit"]);
				this.attempts++;
				return super.transaction(lixId, branchId, run);
			}
		}
		let runtime: ReplayingRuntime | undefined;
		const { call, close } = await connect(lix, (opened) => {
			runtime = new ReplayingRuntime(
				{},
				{ userId: "user", token: "local" },
				async () => null,
				{
					lixSummaries: [
						{
							id: LIX_ID,
							name: "Company",
							slug: "company",
							namespace: { id: LIX_ID, name: "Acme", handle: "acme" },
						},
					],
					openLix: async () => opened,
				},
			);
			return runtime;
		});
		try {
			await seed(lix, { "/target.md": "original" });
			const seen = await head(lix);
			const result = await call("execute_sql", {
				lix_ref: LIX_REF,
				last_seen_commit_id: seen,
				statements: [
					upsert("/target.md", "ours"),
					upsert("/second.md", "second"),
				],
			});
			assert.equal(runtime?.attempts, 2);
			const stored = await files(lix);
			if (concurrentPath === "/target.md") {
				assert.equal(errorOf(result).code, "conflict");
				assert.equal(stored.get("/target.md")?.content, "concurrent edit");
				assert.equal(stored.has("/second.md"), false);
			} else {
				ok(result);
				assert.equal(stored.get("/target.md")?.content, "ours");
				assert.equal(stored.get("/second.md")?.content, "second");
				assert.equal(stored.get("/unrelated.md")?.content, "concurrent edit");
			}
		} finally {
			await close();
		}
	});
}
