import assert from "node:assert/strict";
import test from "node:test";
import {
	MemoryPrototypeWorkingSetStore,
	PrototypeWorkingSetOfflineError,
	PrototypeWorkingSet,
	PrototypeWorkingSetStaleDraftError,
	type PrototypeCommittedFile,
	type PrototypePublishRequest,
	type PrototypePublishResult,
	type PrototypeWorkingSetRemote,
	type PrototypeWorkingSetScope,
} from "./prototype-working-set.ts";

const scope: PrototypeWorkingSetScope = {
	accountId: "account-a",
	repositoryId: "repository-a",
	branchId: "branch-main",
	fileId: "file-readme",
};

class FakeRemote implements PrototypeWorkingSetRemote {
	committed: PrototypeCommittedFile = { revision: "rev-0", content: "base" };
	readCalls = 0;
	commitCount = 0;
	requests: PrototypePublishRequest[] = [];
	online = true;
	loseNextAcknowledgement = false;
	beforeNextPublish: (() => Promise<void>) | undefined;
	private nextRevision = 1;
	private readonly receipts = new Map<string, PrototypePublishResult>();

	async read(): Promise<PrototypeCommittedFile> {
		this.readCalls += 1;
		if (!this.online) throw new PrototypeWorkingSetOfflineError("offline");
		return { ...this.committed };
	}

	async compareAndSet(
		_requestScope: PrototypeWorkingSetScope,
		request: PrototypePublishRequest,
	): Promise<PrototypePublishResult> {
		this.requests.push({ ...request });
		if (this.beforeNextPublish) {
			const before = this.beforeNextPublish;
			this.beforeNextPublish = undefined;
			await before();
		}
		if (!this.online) throw new PrototypeWorkingSetOfflineError("offline");

		const priorReceipt = this.receipts.get(request.operationId);
		if (priorReceipt) return { ...priorReceipt };

		if (
			this.committed.revision !== request.baseRevision ||
			this.committed.content !== request.baseContent
		) {
			return { status: "conflict", actual: { ...this.committed } };
		}

		const result: PrototypePublishResult = {
			status: "committed",
			revision: `rev-${this.nextRevision++}`,
		};
		this.committed = { revision: result.revision, content: request.content };
		this.receipts.set(request.operationId, result);
		this.commitCount += 1;
		if (this.loseNextAcknowledgement) {
			this.loseNextAcknowledgement = false;
			throw new TypeError("Prototype dropped accepted mutation acknowledgment");
		}
		return { ...result };
	}
}

function operationIds(): () => string {
	let next = 0;
	return () => `op-${++next}`;
}

const createTestOperationId = operationIds();

async function open(
	remote: FakeRemote,
	store = new MemoryPrototypeWorkingSetStore(),
	workingScope = scope,
) {
	const workingSet = await PrototypeWorkingSet.open({
		scope: workingScope,
		store,
		remote,
		createOperationId: createTestOperationId,
	});
	return { workingSet, store };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function deferredValue<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

void test("offline edits survive cache reset and reopen without a server read", async () => {
	const remote = new FakeRemote();
	const { workingSet, store } = await open(remote);
	assert.equal(remote.readCalls, 1);

	await workingSet.edit("edited while offline", "base");
	const firstView = await workingSet.read();
	assert.equal(firstView.pending[0]?.baseRevision, "rev-0");
	assert.equal(firstView.pending[0]?.baseContent, "base");
	assert.equal(firstView.pending[0]?.attempted, false);
	assert.equal(remote.requests.length, 0);

	remote.online = false;
	assert.equal((await workingSet.sync()).status, "offline");
	const pendingId = (await workingSet.read()).pending[0]?.operationId;
	assert.equal((await workingSet.read()).pending[0]?.attempted, true);

	await workingSet.resetCache();
	remote.online = true;
	const reopened = await open(remote, store);
	const reopenedView = await reopened.workingSet.read();
	assert.equal(remote.readCalls, 1, "warm reopen must not contact the server");
	assert.equal(reopenedView.content, "edited while offline");
	assert.equal(reopenedView.committed?.revision, "rev-0");
	assert.equal(reopenedView.pending[0]?.operationId, pendingId);
	assert.equal(reopenedView.pending[0]?.baseContent, "base");

	assert.equal((await reopened.workingSet.sync()).status, "synced");
	assert.equal(remote.committed.content, "edited while offline");
});

void test("a lost publish acknowledgement retries the same operation idempotently", async () => {
	const remote = new FakeRemote();
	const { workingSet, store } = await open(remote);
	await workingSet.edit("published once", "base");
	remote.loseNextAcknowledgement = true;

	assert.equal((await workingSet.sync()).status, "offline");
	const attempted = (await workingSet.read()).pending[0];
	assert.equal(attempted?.attempted, true);
	assert.equal(remote.commitCount, 1);

	const reopened = await open(remote, store);
	assert.equal(remote.readCalls, 1);
	assert.equal((await reopened.workingSet.sync()).status, "synced");
	assert.equal(remote.requests.length, 2);
	assert.equal(remote.requests[0]?.operationId, attempted?.operationId);
	assert.equal(remote.requests[1]?.operationId, attempted?.operationId);
	assert.equal(remote.requests[1]?.content, "published once");
	assert.equal(
		remote.commitCount,
		1,
		"the receipt prevents a duplicate commit",
	);
});

void test("conflicts retain the user's pending text and expose the server version", async () => {
	const remote = new FakeRemote();
	const { workingSet, store } = await open(remote);
	await workingSet.edit("my unresolved change", "base");
	const pendingId = (await workingSet.read()).pending[0]?.operationId;
	remote.committed = { revision: "rev-external", content: "server changed" };

	const result = await workingSet.sync();
	assert.equal(result.status, "conflict");
	if (result.status !== "conflict") return;
	assert.equal(result.conflict.actual.content, "server changed");
	assert.equal(result.conflict.localContent, "my unresolved change");

	await workingSet.resetCache();
	const reopened = await open(remote, store);
	const view = await reopened.workingSet.read();
	assert.equal(remote.readCalls, 1);
	assert.equal(view.status, "conflict");
	assert.equal(view.content, "my unresolved change");
	assert.equal(view.pending[0]?.operationId, pendingId);
	assert.equal(view.committed?.content, "server changed");
	assert.equal((await reopened.workingSet.sync()).status, "conflict");

	await reopened.workingSet.resolveConflict("merged local and server text");
	assert.equal((await reopened.workingSet.sync()).status, "synced");
	assert.equal(remote.committed.content, "merged local and server text");
});

void test("edits made during an upload are queued and published on the new base", async () => {
	const remote = new FakeRemote();
	const { workingSet } = await open(remote);
	await workingSet.edit("first draft", "base");
	const uploadGate = deferred();
	const uploadStarted = deferred();
	remote.beforeNextPublish = async () => {
		uploadStarted.resolve();
		await uploadGate.promise;
	};

	const syncing = workingSet.sync();
	await uploadStarted.promise;
	await workingSet.edit("second draft", "first draft");
	await workingSet.edit("latest draft", "second draft");
	const duringUpload = await workingSet.read();
	assert.equal(duringUpload.content, "latest draft");
	assert.equal(duringUpload.pending.length, 2);
	assert.equal(duringUpload.pending[1]?.baseRevision, "rev-0");
	assert.equal(duringUpload.pending[1]?.baseContent, "base");
	uploadGate.resolve();

	assert.equal((await syncing).status, "synced");
	assert.equal(remote.committed.content, "latest draft");
	assert.deepEqual(
		remote.requests.map(({ content }) => content),
		["first draft", "latest draft"],
	);
	assert.notEqual(
		remote.requests[0]?.operationId,
		remote.requests[1]?.operationId,
	);
	assert.equal(remote.requests[1]?.baseRevision, "rev-1");
	assert.equal(remote.requests[1]?.baseContent, "first draft");
});

void test("working sets are isolated by account, repository, branch, and file id", async () => {
	const remoteA = new FakeRemote();
	const remoteB = new FakeRemote();
	remoteB.committed = { revision: "other-rev", content: "other account" };
	const store = new MemoryPrototypeWorkingSetStore();
	const a = await open(remoteA, store);
	const b = await open(remoteB, store, {
		...scope,
		accountId: "account-b",
	});
	await a.workingSet.edit("account A draft", "base");
	assert.equal((await b.workingSet.read()).content, "other account");
	assert.equal((await b.workingSet.read()).pending.length, 0);

	const anotherBranch = await open(remoteB, store, {
		...scope,
		accountId: "account-b",
		branchId: "branch-feature",
	});
	assert.equal(
		(await anotherBranch.workingSet.read()).content,
		"other account",
	);
	assert.equal((await anotherBranch.workingSet.read()).pending.length, 0);

	for (const identity of [
		{ repositoryId: "repository-b" },
		{ fileId: "file-other" },
	]) {
		const isolated = await open(remoteB, store, { ...scope, ...identity });
		assert.equal((await isolated.workingSet.read()).content, "other account");
		assert.equal((await isolated.workingSet.read()).pending.length, 0);
	}
});

void test("a stale second tab cannot replace a newer pending draft", async () => {
	const remote = new FakeRemote();
	const store = new MemoryPrototypeWorkingSetStore();
	const firstTab = await open(remote, store);
	const secondTab = await open(remote, store);

	await firstTab.workingSet.edit("first tab draft", "base");
	await assert.rejects(
		secondTab.workingSet.edit("stale second tab draft", "base"),
		(error: unknown) => {
			assert.ok(error instanceof PrototypeWorkingSetStaleDraftError);
			assert.equal(error.currentContent, "first tab draft");
			return true;
		},
	);
	const view = await firstTab.workingSet.read();
	assert.equal(view.content, "first tab draft");
	assert.equal(view.pending.length, 1);
});

void test("clean warm reads stay local until an explicit refresh", async () => {
	const remote = new FakeRemote();
	const { workingSet } = await open(remote);
	remote.committed = { revision: "rev-external", content: "new server text" };

	assert.equal((await workingSet.read()).content, "base");
	assert.equal(remote.readCalls, 1);
	assert.equal((await workingSet.sync()).status, "clean");
	assert.equal(remote.readCalls, 1);

	assert.equal((await workingSet.refresh()).content, "new server text");
	assert.equal(remote.readCalls, 2);
});

void test("an older refresh response cannot roll a newer cache snapshot backward", async () => {
	const remote = new FakeRemote();
	const { workingSet } = await open(remote);
	const oldResponse = deferredValue<PrototypeCommittedFile>();
	const oldReadStarted = deferred();
	let refreshReadCount = 0;
	remote.read = async () => {
		refreshReadCount += 1;
		if (refreshReadCount === 1) {
			oldReadStarted.resolve();
			return oldResponse.promise;
		}
		return { ...remote.committed };
	};

	const olderRefresh = workingSet.refresh();
	await oldReadStarted.promise;
	remote.committed = { revision: "rev-newer", content: "newer text" };
	assert.equal((await workingSet.refresh()).content, "newer text");
	oldResponse.resolve({ revision: "rev-older", content: "older text" });
	await olderRefresh;
	assert.equal((await workingSet.read()).content, "newer text");
});

void test("authorization and validation failures stay visible to the caller", async () => {
	const remote = new FakeRemote();
	const { workingSet } = await open(remote);
	await workingSet.edit("pending text", "base");
	const authorizationError = Object.assign(new Error("forbidden"), {
		status: 403,
	});
	remote.compareAndSet = async () => {
		throw authorizationError;
	};

	await assert.rejects(workingSet.sync(), authorizationError);
	const view = await workingSet.read();
	assert.equal(view.content, "pending text");
	assert.equal(view.pending.length, 1);
	assert.equal(view.pending[0]?.attempted, true);
});

void test("typed network failures stay retryable while callback failures surface", async () => {
	const remote = new FakeRemote();
	const { workingSet } = await open(remote);
	await workingSet.edit("pending text", "base");
	const operationId = (await workingSet.read()).pending[0]?.operationId;
	assert.ok(operationId);

	const networkError = Object.assign(new Error("connection interrupted"), {
		code: "LIX_TRANSPORT_NETWORK",
	});
	remote.compareAndSet = async () => {
		throw networkError;
	};
	const offline = await workingSet.sync();
	assert.equal(offline.status, "offline");
	if (offline.status !== "offline") return;
	assert.equal(offline.error, networkError);
	assert.equal(offline.pendingCount, 1);
	assert.equal((await workingSet.read()).pending[0]?.operationId, operationId);
	assert.equal((await workingSet.read()).pending[0]?.attempted, true);

	const callbackError = Object.assign(new Error("HTTP adapter failed"), {
		code: "LIX_TRANSPORT_CALLBACK",
	});
	remote.compareAndSet = async () => {
		throw callbackError;
	};
	await assert.rejects(workingSet.sync(), callbackError);
	assert.equal((await workingSet.read()).pending[0]?.operationId, operationId);
});

void test("a stale conflict response cannot poison an operation another tab settled", async () => {
	const remote = new FakeRemote();
	const store = new MemoryPrototypeWorkingSetStore();
	const firstTab = await open(remote, store);
	const secondTab = await open(remote, store);
	await firstTab.workingSet.edit("shared operation", "base");

	let releaseFirst!: (result: PrototypePublishResult) => void;
	const firstResponse = new Promise<PrototypePublishResult>((resolve) => {
		releaseFirst = resolve;
	});
	const firstCallStarted = deferred();
	const publish = remote.compareAndSet.bind(remote);
	let isFirstCall = true;
	remote.compareAndSet = async (requestScope, request) => {
		if (isFirstCall) {
			isFirstCall = false;
			firstCallStarted.resolve();
			return firstResponse;
		}
		return publish(requestScope, request);
	};

	const firstSync = firstTab.workingSet.sync();
	await firstCallStarted.promise;
	assert.equal((await secondTab.workingSet.sync()).status, "synced");
	releaseFirst({
		status: "conflict",
		actual: { ...remote.committed },
	});
	assert.equal((await firstSync).status, "clean");
	assert.equal((await firstTab.workingSet.read()).status, "clean");
});
