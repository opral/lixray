import assert from "node:assert/strict";
import test from "node:test";
import {
	createRepositoryBranchSession,
	createRepositoryPreferencesStore,
	createRepositoryReviewStatusStore,
	createRepositorySessionStateStore,
} from "../lib/atelier-state.ts";
import type { RepositoryLixSession } from "../lib/repository-lix-session.ts";

const USER = "71000000-0000-0000-0000-000000000001";
const OTHER_USER = "71000000-0000-0000-0000-000000000002";
const LIX = "72000000-0000-4000-8000-000000000001";
const OTHER_LIX = "72000000-0000-4000-8000-000000000002";
const MAIN = "73000000-0000-4000-8000-000000000001";
const DRAFT = "73000000-0000-4000-8000-000000000002";
const CREATED = "73000000-0000-4000-8000-000000000003";

void test("shell state survives reloads within one tab but is isolated across tabs", () => {
	const tabAStorage = new MemoryStorage();
	const tabBStorage = new MemoryStorage();
	const storeA = createRepositorySessionStateStore({
		accountId: USER,
		repositoryId: LIX,
		storage: tabAStorage,
	});
	const alreadyOpenStore = createRepositorySessionStateStore({
		accountId: USER,
		repositoryId: LIX,
		storage: tabAStorage,
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
			accountId: USER,
			repositoryId: LIX,
			storage: tabAStorage,
		}).getSnapshot(),
		storeA.getSnapshot(),
		"a reload in the same tab restores its session state",
	);
	assert.equal(
		createRepositorySessionStateStore({
			accountId: USER,
			repositoryId: LIX,
			storage: tabBStorage,
		}).getSnapshot(),
		null,
		"another tab starts with independent shell state",
	);
	assert.equal(
		createRepositorySessionStateStore({
			accountId: OTHER_USER,
			repositoryId: LIX,
			storage: tabAStorage,
		}).getSnapshot(),
		null,
		"another account cannot inherit the previous account's state",
	);
	assert.equal(
		createRepositorySessionStateStore({
			accountId: USER,
			repositoryId: OTHER_LIX,
			storage: tabAStorage,
		}).getSnapshot(),
		null,
		"another lix cannot inherit the previous lix's state",
	);
});

void test("session shell state applies the first-visit initializer", () => {
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
		accountId: USER,
		repositoryId: LIX,
		storage: new MemoryStorage(),
		initializeSnapshot: (persisted) => persisted ?? seededState,
	});

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

void test("demo preferences and tab-local review status survive a same-tab reload", async () => {
	const storage = new MemoryStorage();
	const preferences = createRepositoryPreferencesStore({
		accountId: USER,
		repositoryId: LIX,
		storage,
	});
	await preferences.save({
		version: 1,
		layout: { sizes: { left: 20, central: 50, right: 30 } },
	});
	assert.deepEqual(
		await createRepositoryPreferencesStore({
			accountId: USER,
			repositoryId: LIX,
			storage,
		}).load(),
		{
			version: 1,
			layout: { sizes: { left: 20, central: 50, right: 30 } },
			review: { autoAcceptAgentChanges: false },
		},
	);
	assert.equal(
		await createRepositoryPreferencesStore({
			accountId: USER,
			repositoryId: LIX,
			storage: new MemoryStorage(),
		}).load(),
		null,
		"a separate tab does not inherit user preferences",
	);

	const reviews = createRepositoryReviewStatusStore({
		accountId: USER,
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
			accountId: USER,
			repositoryId: LIX,
			storage,
		}).loadResolvedReviewIds(DRAFT),
		["review-1"],
	);
	assert.deepEqual(
		await createRepositoryReviewStatusStore({
			accountId: OTHER_USER,
			repositoryId: LIX,
			storage,
		}).loadResolvedReviewIds(DRAFT),
		[],
	);
	assert.deepEqual(
		await createRepositoryReviewStatusStore({
			accountId: USER,
			repositoryId: LIX,
			storage: new MemoryStorage(),
		}).loadResolvedReviewIds(DRAFT),
		[],
		"a separate tab does not inherit review-resolution state",
	);
});
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
