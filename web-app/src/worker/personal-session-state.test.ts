import assert from "node:assert/strict";
import test from "node:test";
import type { SwitchBranchOptions } from "@lix-js/sdk";
import {
	createWorkspaceBranchSession,
	createWorkspaceSessionStateStore,
	readWorkspaceSessionBranch,
} from "../lib/atelier-state.ts";
import { openMockRemoteLix, type BrowserLix } from "../lib/mock-remote-lix.ts";

const USER = "71000000-0000-0000-0000-000000000001";
const OTHER_USER = "71000000-0000-0000-0000-000000000002";
const WORKSPACE = "72000000-0000-4000-8000-000000000001";
const MAIN = "73000000-0000-4000-8000-000000000001";
const DRAFT = "73000000-0000-4000-8000-000000000002";
const CREATED = "73000000-0000-4000-8000-000000000003";

void test("shell state is isolated by browsing context, account, and workspace", () => {
	const tabA = new MemoryStorage();
	const tabB = new MemoryStorage();
	const storeA = createWorkspaceSessionStateStore({
		userId: USER,
		workspaceId: WORKSPACE,
		storage: tabA,
	});
	const storeB = createWorkspaceSessionStateStore({
		userId: USER,
		workspaceId: WORKSPACE,
		storage: tabB,
	});
	let tabBNotifications = 0;
	storeB.subscribe(() => {
		tabBNotifications += 1;
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

	assert.equal(storeB.getSnapshot(), null);
	assert.equal(tabBNotifications, 0);
	assert.deepEqual(
		createWorkspaceSessionStateStore({
			userId: USER,
			workspaceId: WORKSPACE,
			storage: tabA,
		}).getSnapshot(),
		storeA.getSnapshot(),
		"the same tab restores its state after reload",
	);
	assert.equal(
		createWorkspaceSessionStateStore({
			userId: OTHER_USER,
			workspaceId: WORKSPACE,
			storage: tabA,
		}).getSnapshot(),
		null,
		"another account cannot inherit the previous account's tab state",
	);
});

void test("branch selection is observable and private to one browsing context", async () => {
	const tabA = new MemoryStorage();
	const tabB = new MemoryStorage();
	const lixA = fakeBrowserLix(MAIN);
	const lixB = fakeBrowserLix(MAIN);
	let routedBranch: string | null = null;
	const branchA = createWorkspaceBranchSession({
		lix: lixA,
		userId: USER,
		workspaceId: WORKSPACE,
		storage: tabA,
		onSwitch: (branchId) => {
			routedBranch = branchId;
		},
	});
	createWorkspaceBranchSession({
		lix: lixB,
		userId: USER,
		workspaceId: WORKSPACE,
		storage: tabB,
		onSwitch: () => undefined,
	});
	let notifications = 0;
	branchA.subscribe(() => {
		notifications += 1;
	});

	await branchA.switchBranch(DRAFT);

	assert.equal(branchA.getSnapshot(), DRAFT);
	assert.equal(routedBranch, DRAFT);
	assert.equal(notifications, 1);
	assert.equal(
		readWorkspaceSessionBranch({
			userId: USER,
			workspaceId: WORKSPACE,
			storage: tabA,
		}),
		DRAFT,
	);
	assert.equal(
		readWorkspaceSessionBranch({
			userId: USER,
			workspaceId: WORKSPACE,
			storage: tabB,
		}),
		MAIN,
	);

	assert.equal(await branchA.createBranch("Review"), CREATED);
	assert.equal(branchA.getSnapshot(), CREATED);
	assert.equal(routedBranch, CREATED);
	assert.equal(notifications, 2);
	assert.equal(
		readWorkspaceSessionBranch({
			userId: USER,
			workspaceId: WORKSPACE,
			storage: tabA,
		}),
		CREATED,
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

function fakeBrowserLix(initialBranchId: string): BrowserLix {
	let activeBranchId = initialBranchId;
	const listeners = new Set<() => void>();
	return {
		activeBranchSnapshot: () => activeBranchId,
		mainBranchSnapshot: () => MAIN,
		subscribeActiveBranch: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		createBranch: async () => {
			activeBranchId = CREATED;
			for (const listener of [...listeners]) listener();
			return { id: activeBranchId };
		},
		switchBranch: async (options: SwitchBranchOptions) => {
			activeBranchId = options.branchId;
			for (const listener of [...listeners]) listener();
			return { branchId: activeBranchId };
		},
	} as unknown as BrowserLix;
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
