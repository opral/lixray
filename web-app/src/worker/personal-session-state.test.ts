import assert from "node:assert/strict";
import test from "node:test";
import {
	ATELIER_SESSION_UI_STATE_KEY,
	ATELIER_USER_PREFERENCES_KEY,
	type AtelierClientState,
} from "@opral/atelier/state-adapters";
import {
	createRepositoryBranchSession,
	createRepositoryPreferencesStore,
	createRepositoryReviewStatusStore,
	createRepositorySessionStateStore,
} from "../lib/atelier-state.ts";
import type { LixraySupabaseClient } from "../lib/supabase.ts";
import {
	openRepositoryLixSession,
	type RepositoryLixSession,
} from "../lib/repository-lix-session.ts";

const USER = "71000000-0000-0000-0000-000000000001";
const OTHER_USER = "71000000-0000-0000-0000-000000000002";
const LIX = "72000000-0000-4000-8000-000000000001";
const OTHER_LIX = "72000000-0000-4000-8000-000000000002";
const MAIN = "73000000-0000-4000-8000-000000000001";
const DRAFT = "73000000-0000-4000-8000-000000000002";
const CREATED = "73000000-0000-4000-8000-000000000003";

void test("shell state is shared across new tabs and isolated by account and lix", () => {
	const browserStorage = new MemoryStorage();
	const storeA = createRepositorySessionStateStore({
		userId: USER,
		repositoryId: LIX,
		storage: browserStorage,
	});
	const alreadyOpenStore = createRepositorySessionStateStore({
		userId: USER,
		repositoryId: LIX,
		storage: browserStorage,
	});
	let alreadyOpenNotifications = 0;
	alreadyOpenStore.subscribe(() => {
		alreadyOpenNotifications += 1;
	});

	storeA.setSnapshot({
		focusedPanel: "central",
		panels: {
			left: { views: [], activeInstance: null },
			central: {
				views: [{ instance: "files-a", kind: "atelier_files" }],
				activeInstance: "files-a",
			},
			right: { views: [], activeInstance: null },
		},
	});

	assert.equal(alreadyOpenStore.getSnapshot(), null);
	assert.equal(alreadyOpenNotifications, 0);
	assert.deepEqual(
		createRepositorySessionStateStore({
			userId: USER,
			repositoryId: LIX,
			storage: browserStorage,
		}).getSnapshot(),
		storeA.getSnapshot(),
		"a new tab restores state from the shared browser storage",
	);
	assert.equal(
		createRepositorySessionStateStore({
			userId: OTHER_USER,
			repositoryId: LIX,
			storage: browserStorage,
		}).getSnapshot(),
		null,
		"another account cannot inherit the previous account's state",
	);
	assert.equal(
		createRepositorySessionStateStore({
			userId: USER,
			repositoryId: OTHER_LIX,
			storage: browserStorage,
		}).getSnapshot(),
		null,
		"another lix cannot inherit the previous lix's state",
	);
});

void test("Atelier shell and layout state use the client Lix without remote or browser fallback writes", async () => {
	const values = new Map<string, unknown>();
	const listeners = new Set<() => void>();
	const clientState: AtelierClientState = {
		get: async (key) => values.get(key) as never,
		set: async (key, value) => {
			values.set(key, value);
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const fallbackStorage = new MemoryStorage();
	const rejectingRemote = {
		from: () => {
			throw new Error("Atelier UI state must not reach Supabase");
		},
	} as unknown as LixraySupabaseClient;
	const shell = createRepositorySessionStateStore({
		userId: USER,
		repositoryId: LIX,
		clientState,
		storage: fallbackStorage,
	});
	const preferences = createRepositoryPreferencesStore({
		client: rejectingRemote,
		userId: USER,
		repositoryId: LIX,
		clientState,
		storage: fallbackStorage,
	});
	const shellState = {
		focusedPanel: "right" as const,
		panels: {
			left: { views: [], activeInstance: null },
			central: { views: [], activeInstance: null },
			right: {
				views: [{ instance: "files-client", kind: "atelier_files" }],
				activeInstance: "files-client",
			},
		},
	};

	shell.setSnapshot(shellState);
	await preferences.save({
		version: 1,
		layout: { sizes: { left: 10, central: 65, right: 25 } },
	});

	assert.deepEqual(values.get(ATELIER_SESSION_UI_STATE_KEY), shellState);
	assert.deepEqual(values.get(ATELIER_USER_PREFERENCES_KEY), {
		version: 1,
		layout: { sizes: { left: 10, central: 65, right: 25 } },
		review: { autoAcceptAgentChanges: false },
	});
	assert.equal(fallbackStorage.length, 0);
	const restoredShell = createRepositorySessionStateStore({
		userId: USER,
		repositoryId: LIX,
		clientState,
	});
	await waitFor(() => restoredShell.getSnapshot() !== null);
	assert.deepEqual(
		restoredShell.getSnapshot(),
		shellState,
		"a second consumer of this client Lix can restore shell state",
	);
	assert.deepEqual(
		await createRepositoryPreferencesStore({
			client: rejectingRemote,
			userId: USER,
			repositoryId: LIX,
			clientState,
		}).load(),
		{
			version: 1,
			layout: { sizes: { left: 10, central: 65, right: 25 } },
			review: { autoAcceptAgentChanges: false },
		},
		"a second consumer of this client Lix can restore layout state",
	);
	assert.equal(
		createRepositorySessionStateStore({
			userId: OTHER_USER,
			repositoryId: LIX,
			clientState: memoryClientState(),
		}).getSnapshot(),
		null,
		"another client-state namespace does not inherit this UI state",
	);
});

void test("client Lix shell state applies the first-visit initializer", async () => {
	const seededState = {
		focusedPanel: "central" as const,
		panels: {
			left: { views: [], activeInstance: null },
			central: {
				views: [
					{ instance: "getting-started", kind: "lixray_getting_started" },
				],
				activeInstance: "getting-started",
			},
			right: { views: [], activeInstance: null },
		},
	};
	const store = createRepositorySessionStateStore({
		userId: USER,
		repositoryId: LIX,
		clientState: memoryClientState(),
		initializeSnapshot: (persisted) => persisted ?? seededState,
	});

	await waitFor(() => store.getSnapshot() !== null);
	assert.deepEqual(store.getSnapshot(), seededState);
});

void test("branch selection is serialized and only the latest request is routed", async () => {
	let activeBranchId = MAIN;
	let releaseDraft: () => void = () => undefined;
	let markDraftStarted: () => void = () => undefined;
	const draftBlocked = new Promise<void>((resolve) => {
		releaseDraft = resolve;
	});
	const draftStarted = new Promise<void>((resolve) => {
		markDraftStarted = resolve;
	});
	const selected: string[] = [];
	const routed: string[] = [];
	const session = {
		activeBranchSnapshot: () => activeBranchId,
		defaultBranchSnapshot: () => MAIN,
		subscribeActiveBranch: () => () => undefined,
		switchBranch: async (branchId: string) => {
			selected.push(branchId);
			if (branchId === DRAFT) {
				markDraftStarted();
				await draftBlocked;
			}
			activeBranchId = branchId;
			return branchId;
		},
	} as unknown as RepositoryLixSession;
	const branch = createRepositoryBranchSession({
		session,
		onSwitch: (branchId) => {
			routed.push(branchId);
		},
	});

	const selectDraft = branch.switchBranch(DRAFT);
	await draftStarted;
	const selectCreated = branch.switchBranch(CREATED);
	assert.deepEqual(selected, [DRAFT], "the second switch waits for the first");

	releaseDraft();
	await Promise.all([selectDraft, selectCreated]);

	assert.deepEqual(selected, [DRAFT, CREATED]);
	assert.deepEqual(routed, [CREATED]);
	assert.equal(branch.getSnapshot(), CREATED);
});

void test("a failed latest branch selection reconciles the last successful branch", async () => {
	let activeBranchId = MAIN;
	let releaseDraft: () => void = () => undefined;
	let markDraftStarted: () => void = () => undefined;
	const draftBlocked = new Promise<void>((resolve) => {
		releaseDraft = resolve;
	});
	const draftStarted = new Promise<void>((resolve) => {
		markDraftStarted = resolve;
	});
	const routed: string[] = [];
	const session = {
		activeBranchSnapshot: () => activeBranchId,
		defaultBranchSnapshot: () => MAIN,
		subscribeActiveBranch: () => () => undefined,
		switchBranch: async (branchId: string) => {
			if (branchId === DRAFT) {
				markDraftStarted();
				await draftBlocked;
				activeBranchId = branchId;
				return branchId;
			}
			throw new Error(`Unable to switch to ${branchId}`);
		},
	} as unknown as RepositoryLixSession;
	const branch = createRepositoryBranchSession({
		session,
		onSwitch: (branchId) => {
			routed.push(branchId);
		},
	});

	const selectDraft = branch.switchBranch(DRAFT);
	await draftStarted;
	const selectCreated = branch.switchBranch(CREATED);
	releaseDraft();

	await selectDraft;
	await assert.rejects(selectCreated, /Unable to switch/);
	assert.equal(branch.getSnapshot(), DRAFT);
	assert.deepEqual(
		routed,
		[DRAFT],
		"the successfully selected branch becomes authoritative when its successor fails",
	);
});

void test("demo preferences and review status survive a same-tab reload", async () => {
	const storage = new MemoryStorage();
	const preferences = createRepositoryPreferencesStore({
		client: null,
		userId: USER,
		repositoryId: LIX,
		storage,
	});
	await preferences.save({
		version: 1,
		layout: { sizes: { left: 20, central: 50, right: 30 } },
	});
	assert.deepEqual(
		await createRepositoryPreferencesStore({
			client: null,
			userId: USER,
			repositoryId: LIX,
			storage,
		}).load(),
		{
			version: 1,
			layout: { sizes: { left: 20, central: 50, right: 30 } },
			review: { autoAcceptAgentChanges: false },
		},
	);

	const reviews = createRepositoryReviewStatusStore({
		client: null,
		userId: USER,
		repositoryId: LIX,
		storage,
	});
	await reviews.resolve({
		branchId: DRAFT,
		reviewId: "review-1",
		fileId: "file-1",
		outcome: "accepted",
	});
	assert.deepEqual(
		await createRepositoryReviewStatusStore({
			client: null,
			userId: USER,
			repositoryId: LIX,
			storage,
		}).loadResolvedReviewIds(DRAFT),
		["review-1"],
	);
	assert.deepEqual(
		await createRepositoryReviewStatusStore({
			client: null,
			userId: OTHER_USER,
			repositoryId: LIX,
			storage,
		}).loadResolvedReviewIds(DRAFT),
		[],
	);
});

void test("failed remote review persistence survives tab loss and retries idempotently", async () => {
	const durableStorage = new MemoryStorage();
	const remoteReviewIds = new Set<string>();
	let upsertAttempts = 0;
	const client = fakeReviewClient({
		load: () => [...remoteReviewIds],
		upsert: (row) => {
			upsertAttempts += 1;
			if (upsertAttempts === 1) return new Error("temporarily unavailable");
			remoteReviewIds.add(row.review_id);
			return null;
		},
	});
	const reviews = createRepositoryReviewStatusStore({
		client,
		userId: USER,
		repositoryId: LIX,
		durableStorage,
	});

	await reviews.resolve({
		branchId: DRAFT,
		reviewId: "review-outbox",
		fileId: "file-outbox",
		outcome: "rejected",
	});
	assert.equal(upsertAttempts, 1);
	assert.deepEqual(
		await createRepositoryReviewStatusStore({
			client: null,
			userId: USER,
			repositoryId: LIX,
			storage: durableStorage,
		}).loadResolvedReviewIds(DRAFT),
		["review-outbox"],
		"the local acknowledgement is durable before the remote write succeeds",
	);

	const freshTab = createRepositoryReviewStatusStore({
		client,
		userId: USER,
		repositoryId: LIX,
		durableStorage,
	});
	assert.deepEqual(await freshTab.loadResolvedReviewIds(DRAFT), [
		"review-outbox",
	]);
	assert.equal(upsertAttempts, 2);
	assert.deepEqual(await freshTab.loadResolvedReviewIds(DRAFT), [
		"review-outbox",
	]);
	assert.equal(
		upsertAttempts,
		2,
		"a flushed outbox entry is not retried again",
	);
});

void test("lix sessions use unified remote Lix with session-local branch state and rebound observations", async (t) => {
	const executeBranches: string[] = [];
	const createBodies: unknown[] = [];
	const requestPaths: string[] = [];
	let activeBranchId = MAIN;
	let observeOpenCount = 0;
	let observationSequence = 0;
	let observationController:
		| ReadableStreamDefaultController<Uint8Array>
		| undefined;
	let observationSubscriptionId: string | undefined;
	const emitObservation = () => {
		if (!observationController || !observationSubscriptionId) return;
		const frame = `event: next\ndata: ${JSON.stringify({
			subscriptionId: observationSubscriptionId,
			sequence: observationSequence++,
			mutationSequence: observationSequence,
			result: {
				columns: ["branch"],
				rows: [[{ kind: "text", value: activeBranchId }]],
				rowsAffected: 0,
				notices: [],
			},
		})}\n\n`;
		observationController.enqueue(new TextEncoder().encode(frame));
	};
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request
				? input
				: new Request(new URL(input, "https://lixray.test"), init);
		const pathname = new URL(request.url).pathname;
		requestPaths.push(pathname);
		if (pathname.endsWith("/lix/v1/")) {
			return Response.json({
				protocolVersion: 2,
				activeBranchId,
				activeAccountId: "00000000-0000-7000-8000-000000000002",
				sessionId: "lix-session",
			});
		}
		if (pathname.endsWith("/lix/v1/session") && request.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		const body: Record<string, unknown> = request.body
			? ((await request.clone().json()) as Record<string, unknown>)
			: {};
		if (pathname.endsWith("/branch/switch")) {
			const branchId = body.branchId;
			if (branchId === "invalid-branch") {
				return Response.json(
					{
						error: {
							code: "LIX_BRANCH_NOT_FOUND",
							message: "Branch not found",
						},
					},
					{ status: 404 },
				);
			}
			activeBranchId = String(branchId);
			emitObservation();
			return Response.json({ branchId });
		}
		if (pathname.endsWith("/branch/create")) {
			createBodies.push(body);
			return Response.json({
				id: CREATED,
				name: "Created",
				hidden: false,
				commitId: "created-commit",
			});
		}
		if (pathname.endsWith("/execute")) {
			if (body.sql === "SELECT branch") {
				return Response.json({
					columns: ["branch"],
					rows: [[{ kind: "text", value: activeBranchId }]],
					rowsAffected: 0,
					notices: [],
				});
			}
			executeBranches.push(activeBranchId);
			return Response.json({
				columns: [],
				rows: [],
				rowsAffected: 0,
				notices: [],
			});
		}
		if (pathname.endsWith("/observe/multiplex")) {
			observeOpenCount += 1;
			const subscriptions = body.subscriptions as Array<{ id: string }>;
			observationSubscriptionId = subscriptions[0]?.id;
			const signal = request.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						observationController = controller;
						emitObservation();
						if (signal?.aborted) controller.close();
						else {
							signal?.addEventListener(
								"abort",
								() => {
									observationController = undefined;
									controller.close();
								},
								{ once: true },
							);
						}
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return new Response("Not found", { status: 404 });
	};
	const session = await openRepositoryLixSession({
		namespace: "acme",
		repositorySlug: "launch-q3",
		origin: "https://lixray.test",
		getAccessToken: async () => "token",
		initialBranchId: "invalid-branch",
		fetch,
	});
	t.after(() => session.close());
	assert.equal(session.activeBranchSnapshot(), MAIN);
	await session.lix.execute("SELECT 1");
	const events = session.lix.observe("SELECT branch");
	t.after(() => events.close());
	assert.equal((await events.next())?.result.rows[0]?.get("branch"), MAIN);
	await session.switchBranch(DRAFT);
	assert.equal((await events.next())?.result.rows[0]?.get("branch"), DRAFT);
	await session.lix.execute("SELECT 2");
	assert.equal(await session.createBranch("Created"), CREATED);
	assert.equal(session.activeBranchSnapshot(), CREATED);
	assert.equal((await events.next())?.result.rows[0]?.get("branch"), CREATED);
	await waitFor(() => observeOpenCount === 3);
	assert.deepEqual(executeBranches, [MAIN, DRAFT]);
	assert.deepEqual(createBodies, [{ name: "Created" }]);
	assert.equal(
		observeOpenCount,
		3,
		"the initial observation is rebound after each successful branch switch",
	);
	assert.equal(requestPaths[0], "/@acme/launch-q3/lix/v1/");
	assert.ok(requestPaths.includes("/@acme/launch-q3/lix/v1/observe/multiplex"));
});

type RemoteReviewRow = {
	review_id: string;
};

function fakeReviewClient(args: {
	load: () => string[];
	upsert: (row: RemoteReviewRow) => Error | null;
}): LixraySupabaseClient {
	return {
		from: () => new FakeReviewQuery(args),
	} as unknown as LixraySupabaseClient;
}

class FakeReviewQuery {
	readonly #args: {
		load: () => string[];
		upsert: (row: RemoteReviewRow) => Error | null;
	};

	constructor(args: {
		load: () => string[];
		upsert: (row: RemoteReviewRow) => Error | null;
	}) {
		this.#args = args;
	}

	select(): this {
		return this;
	}

	eq(): this {
		return this;
	}

	async upsert(row: RemoteReviewRow): Promise<{ error: Error | null }> {
		return { error: this.#args.upsert(row) };
	}

	then<TResult1 = { data: RemoteReviewRow[]; error: null }, TResult2 = never>(
		onfulfilled?:
			| ((value: {
					data: RemoteReviewRow[];
					error: null;
			  }) => TResult1 | PromiseLike<TResult1>)
			| null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return Promise.resolve({
			data: this.#args.load().map((review_id) => ({ review_id })),
			error: null,
		}).then(onfulfilled, onrejected);
	}
}

class MemoryStorage implements Storage {
	readonly #values = new Map<string, string>();

	get length(): number {
		return this.#values.size;
	}

	clear(): void {
		this.#values.clear();
	}

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}
}

function memoryClientState(): AtelierClientState {
	const values = new Map<string, never>();
	return {
		get: async (key) => values.get(key),
		set: async (key, value) => {
			values.set(key, value as never);
		},
		subscribe: () => () => undefined,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for asynchronous session state");
}
