import assert from "node:assert/strict";
import test from "node:test";
import type { SwitchBranchOptions } from "@lix-js/sdk";
import {
	createWorkspaceBranchSession,
	createWorkspacePreferencesStore,
	createWorkspaceReviewStatusStore,
	createWorkspaceSessionStateStore,
} from "../lib/atelier-state.ts";
import { openMockRemoteLix, type BrowserLix } from "../lib/mock-remote-lix.ts";
import type { LixraySupabaseClient } from "../lib/supabase.ts";

const USER = "71000000-0000-0000-0000-000000000001";
const OTHER_USER = "71000000-0000-0000-0000-000000000002";
const WORKSPACE = "72000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "72000000-0000-4000-8000-000000000002";
const MAIN = "73000000-0000-4000-8000-000000000001";
const DRAFT = "73000000-0000-4000-8000-000000000002";
const CREATED = "73000000-0000-4000-8000-000000000003";

void test("shell state is shared across new tabs and isolated by account and workspace", () => {
	const browserStorage = new MemoryStorage();
	const storeA = createWorkspaceSessionStateStore({
		userId: USER,
		workspaceId: WORKSPACE,
		storage: browserStorage,
	});
	const alreadyOpenStore = createWorkspaceSessionStateStore({
		userId: USER,
		workspaceId: WORKSPACE,
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
		createWorkspaceSessionStateStore({
			userId: USER,
			workspaceId: WORKSPACE,
			storage: browserStorage,
		}).getSnapshot(),
		storeA.getSnapshot(),
		"a new tab restores state from the shared browser storage",
	);
	assert.equal(
		createWorkspaceSessionStateStore({
			userId: OTHER_USER,
			workspaceId: WORKSPACE,
			storage: browserStorage,
		}).getSnapshot(),
		null,
		"another account cannot inherit the previous account's state",
	);
	assert.equal(
		createWorkspaceSessionStateStore({
			userId: USER,
			workspaceId: OTHER_WORKSPACE,
			storage: browserStorage,
		}).getSnapshot(),
		null,
		"another workspace cannot inherit the previous workspace's state",
	);
});

void test("legacy tab shell state migrates unless browser state already exists", () => {
	const localStorage = new MemoryStorage();
	const sessionStorage = new MemoryStorage();
	const key = `lixray.atelier.shell.v1:${USER}:${WORKSPACE}`;
	const legacyState = {
		focusedPanel: "left" as const,
		panels: {
			left: {
				views: [{ instance: "files-legacy", kind: "atelier_files" }],
				activeInstance: "files-legacy",
			},
			central: { views: [], activeInstance: null },
			right: { views: [], activeInstance: null },
		},
	};
	const browserState = {
		...legacyState,
		focusedPanel: "right" as const,
	};
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { localStorage, sessionStorage },
	});
	try {
		sessionStorage.setItem(key, JSON.stringify(legacyState));
		assert.deepEqual(
			createWorkspaceSessionStateStore({
				userId: USER,
				workspaceId: WORKSPACE,
			}).getSnapshot(),
			legacyState,
		);
		assert.deepEqual(
			JSON.parse(localStorage.getItem(key) ?? "null"),
			legacyState,
		);
		assert.equal(sessionStorage.getItem(key), null);

		localStorage.setItem(key, JSON.stringify(browserState));
		sessionStorage.setItem(key, JSON.stringify(legacyState));
		assert.deepEqual(
			createWorkspaceSessionStateStore({
				userId: USER,
				workspaceId: WORKSPACE,
			}).getSnapshot(),
			browserState,
			"existing browser state takes precedence over legacy tab state",
		);
		assert.equal(sessionStorage.getItem(key), null);
	} finally {
		if (previousWindow) {
			Object.defineProperty(globalThis, "window", previousWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
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
	const lix = {
		activeBranchSnapshot: () => activeBranchId,
		mainBranchSnapshot: () => MAIN,
		subscribeActiveBranch: () => () => undefined,
		switchBranch: async ({ branchId }: SwitchBranchOptions) => {
			selected.push(branchId);
			if (branchId === DRAFT) {
				markDraftStarted();
				await draftBlocked;
			}
			activeBranchId = branchId;
			return { branchId };
		},
	} as unknown as BrowserLix;
	const branch = createWorkspaceBranchSession({
		lix,
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
	const lix = {
		activeBranchSnapshot: () => activeBranchId,
		mainBranchSnapshot: () => MAIN,
		subscribeActiveBranch: () => () => undefined,
		switchBranch: async ({ branchId }: SwitchBranchOptions) => {
			if (branchId === DRAFT) {
				markDraftStarted();
				await draftBlocked;
				activeBranchId = branchId;
				return { branchId };
			}
			throw new Error(`Unable to switch to ${branchId}`);
		},
	} as unknown as BrowserLix;
	const branch = createWorkspaceBranchSession({
		lix,
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
	const preferences = createWorkspacePreferencesStore({
		client: null,
		userId: USER,
		workspaceId: WORKSPACE,
		storage,
	});
	await preferences.save({
		version: 1,
		layout: { sizes: { left: 20, central: 50, right: 30 } },
	});
	assert.deepEqual(
		await createWorkspacePreferencesStore({
			client: null,
			userId: USER,
			workspaceId: WORKSPACE,
			storage,
		}).load(),
		{
			version: 1,
			layout: { sizes: { left: 20, central: 50, right: 30 } },
		},
	);

	const reviews = createWorkspaceReviewStatusStore({
		client: null,
		userId: USER,
		workspaceId: WORKSPACE,
		storage,
	});
	await reviews.resolve({
		branchId: DRAFT,
		reviewId: "review-1",
		fileId: "file-1",
		outcome: "accepted",
	});
	assert.deepEqual(
		await createWorkspaceReviewStatusStore({
			client: null,
			userId: USER,
			workspaceId: WORKSPACE,
			storage,
		}).loadResolvedReviewIds(DRAFT),
		["review-1"],
	);
	assert.deepEqual(
		await createWorkspaceReviewStatusStore({
			client: null,
			userId: OTHER_USER,
			workspaceId: WORKSPACE,
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
	const reviews = createWorkspaceReviewStatusStore({
		client,
		userId: USER,
		workspaceId: WORKSPACE,
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
		await createWorkspaceReviewStatusStore({
			client: null,
			userId: USER,
			workspaceId: WORKSPACE,
			storage: durableStorage,
		}).loadResolvedReviewIds(DRAFT),
		["review-outbox"],
		"the local acknowledgement is durable before the remote write succeeds",
	);

	const freshTab = createWorkspaceReviewStatusStore({
		client,
		userId: USER,
		workspaceId: WORKSPACE,
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

void test("browser Lix validates the initial branch and pins each request explicitly", async () => {
	const executeBodies: unknown[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const pathname = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
			"https://lixray.test",
		).pathname;
		if (pathname.endsWith("/branches")) {
			return Response.json({
				branches: [
					{ id: MAIN, name: "main", hidden: false, commitId: "commit-main" },
					{
						id: DRAFT,
						name: "Draft",
						hidden: false,
						commitId: "commit-draft",
					},
				],
			});
		}
		if (pathname.endsWith("/execute")) {
			const body = init?.body;
			if (typeof body !== "string") throw new Error("Expected a JSON body");
			executeBodies.push(JSON.parse(body) as unknown);
			return Response.json({
				columns: [],
				rows: [],
				rowsAffected: 0,
				notices: [],
			});
		}
		return new Response("Not found", { status: 404 });
	};
	const lix = await openMockRemoteLix({
		workspaceId: WORKSPACE,
		getAccessToken: async () => "token",
		initialBranchId: "invalid-branch",
		fetch,
	});
	assert.equal(lix.activeBranchSnapshot(), MAIN);
	await lix.execute("SELECT 1");
	await lix.switchBranch({ branchId: DRAFT });
	await lix.execute("SELECT 2");
	assert.deepEqual(
		executeBodies.map((body) => (body as { branchId: string }).branchId),
		[MAIN, DRAFT],
	);
	await lix.close();
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
