import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { installSyncDiagnostics } from "./sync-diagnostics.ts";

type MessageListener = (event: { data: unknown }) => void;
type InputMessage = {
	kind?: string;
	client?: string;
	generation?: string;
	message?: {
		id?: number;
		sessionId?: number;
		operation?: { kind?: string; sql?: string };
	};
};

class FakeMessageEvent {
	data: unknown;

	constructor(_type: string, init: { data: unknown }) {
		this.data = init.data;
	}
}

class FakeBroadcastChannel {
	private readonly listeners = new Set<MessageListener>();
	readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	addEventListener(_type: string, listener: MessageListener) {
		this.listeners.add(listener);
	}

	removeEventListener(_type: string, listener: MessageListener) {
		this.listeners.delete(listener);
	}

	postMessage(message: unknown) {
		postHandler(this, message);
	}

	dispatch(data: unknown) {
		for (const listener of this.listeners)
			listener(new FakeMessageEvent("message", { data }));
	}
}

class FakeSharedWorker {}

let postHandler: (
	channel: FakeBroadcastChannel,
	message: unknown,
) => void = () => undefined;

type DiagnosticsPage = {
	BroadcastChannel: new (name: string) => FakeBroadcastChannel;
	__lixSyncFiles: () => Promise<unknown>;
	__lixSyncDiagnostic: (path: string) => Promise<{
		observerFrames: Array<{
			operation?: { kind?: string };
			response?: { ok?: boolean };
		}>;
		lifecycle: Array<{ kind?: string }>;
		pendingOperations: Array<{ id?: number; kind?: string }>;
	}>;
};

async function createDiagnosticPage() {
	let initScript: (() => void) | undefined;
	await installSyncDiagnostics({
		addInitScript: async (script: unknown) => {
			initScript = script as () => void;
		},
	} as never);
	assert.equal(typeof initScript, "function");

	const delayedIds = new Set<number>();
	let failNextExecute = false;
	postHandler = (channel, raw) => {
		const input = raw as InputMessage;
		if (input.kind !== "input" || typeof input.message?.id !== "number") return;
		const request = input.message;
		const id = request.id!;
		const operation = request.operation;
		const emit = (message: unknown) =>
			channel.dispatch({
				kind: "output",
				client: input.client,
				message,
			});
		emit({ kind: "request.started", id });
		emit({ kind: "request.queued", id });
		const delay = delayedIds.delete(id) ? 100 : 15;
		setTimeout(() => {
			if (failNextExecute && operation?.kind === "execute") {
				failNextExecute = false;
				emit({ id, ok: false, error: { message: "synthetic RPC failure" } });
				return;
			}
			const value = operation?.kind?.startsWith("observe")
				? { cursor: 12 }
				: operation?.kind === "execute"
					? [{ id: "file-1", path: "/doc.md" }]
					: { state: "running" };
			emit({ id, ok: true, value });
		}, delay);
	};

	const sandbox: Record<string, unknown> = {
		BroadcastChannel: FakeBroadcastChannel,
		SharedWorker: FakeSharedWorker,
		MessageEvent: FakeMessageEvent,
		performance,
		setTimeout,
		clearTimeout,
		TextDecoder,
		Uint8Array,
	};
	runInNewContext(`(${initScript!.toString()})()`, sandbox, { timeout: 1000 });
	return {
		page: sandbox as unknown as DiagnosticsPage,
		delayedIds,
		failNextExecute: () => {
			failNextExecute = true;
		},
	};
}

void test("serialized diagnostics ignore lifecycle replies until terminal responses", async () => {
	const { page, delayedIds, failNextExecute } = await createDiagnosticPage();
	const channel = new page.BroadcastChannel("lix:repository-rpc:v1:test");
	channel.postMessage({
		kind: "input",
		client: "test-client",
		generation: "test-generation",
		message: {
			id: 100,
			sessionId: 1,
			operation: { kind: "open" },
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 20));

	// Delay the normal file probe while another diagnostic RPC inspects the
	// pending journal. Started/queued events must leave it pending.
	delayedIds.add(-1);
	let filesSettled = false;
	const files = page.__lixSyncFiles().finally(() => {
		filesSettled = true;
	});
	delayedIds.add(41);
	channel.postMessage({
		kind: "input",
		client: "test-client",
		generation: "test-generation",
		message: {
			id: 41,
			sessionId: 1,
			operation: { kind: "observe.next" },
		},
	});
	const diagnostics = await page.__lixSyncDiagnostic("/doc.md");
	assert.equal(filesSettled, false);
	assert.ok(diagnostics.pendingOperations.some((request) => request.id === 41));
	assert.equal(diagnostics.observerFrames.length, 0);
	await new Promise((resolve) => setTimeout(resolve, 110));
	assert.deepEqual(await files, [{ id: "file-1", path: "/doc.md" }]);

	// An observer stays correlated through lifecycle messages and is recorded
	// only when its terminal response arrives.
	const afterObserverReply = await page.__lixSyncDiagnostic("/doc.md");
	assert.ok(
		afterObserverReply.observerFrames.some(
			(frame) =>
				frame.operation?.kind === "observe.next" && frame.response?.ok === true,
		),
	);
	assert.ok(
		afterObserverReply.lifecycle.some(
			(entry) => entry.kind === "request.started",
		),
	);
	assert.equal(
		afterObserverReply.pendingOperations.some((request) => request.id === 41),
		false,
	);

	// A terminal failure is returned as an error payload instead of being lost
	// after the matching lifecycle notification.
	failNextExecute();
	const failedFiles = (await page.__lixSyncFiles()) as {
		error?: { message?: string };
	};
	assert.equal(failedFiles.error?.message, "synthetic RPC failure");
});
