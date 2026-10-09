import assert from "node:assert/strict";
import test from "node:test";
import {
	acquireManagedRepositoryResource,
	closeManagedRepositoryResourcesForPageUnload,
} from "./repository-session-manager.ts";

void test("reuses a repository resource while Strict Mode remounts", async () => {
	let openCount = 0;
	let closeCount = 0;
	const open = async () => {
		openCount += 1;
		return {
			async close() {
				closeCount += 1;
			},
		};
	};

	const first = await acquireManagedRepositoryResource("repository-1", open);
	first.release();
	const second = await acquireManagedRepositoryResource("repository-1", open);

	assert.equal(second.resource, first.resource);
	assert.equal(first.acquisition, "created");
	assert.equal(second.acquisition, "reused");
	assert.equal(openCount, 1);
	assert.equal(closeCount, 0);

	second.release();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(closeCount, 1);
});

void test("a coalesced pending acquisition is distinct from a live session reuse", async () => {
	let ready!: () => void;
	const open = async () => {
		await new Promise<void>((resolve) => {
			ready = resolve;
		});
		return { close: async () => {} };
	};
	const first = acquireManagedRepositoryResource("profile-pending", open);
	const joined = acquireManagedRepositoryResource("profile-pending", open);
	ready();
	const [created, coalesced] = await Promise.all([first, joined]);
	const reused = await acquireManagedRepositoryResource(
		"profile-pending",
		open,
	);
	assert.equal(created.acquisition, "created");
	assert.equal(coalesced.acquisition, "joined");
	assert.equal(reused.acquisition, "reused");
	created.release();
	coalesced.release();
	reused.release();
});

void test("starts one close lifecycle during a real page unload", async () => {
	let closeCount = 0;
	let finishClose!: () => void;
	const lease = await acquireManagedRepositoryResource(
		"repository-page-unload",
		async () => ({
			async close() {
				closeCount += 1;
				await new Promise<void>((resolve) => {
					finishClose = resolve;
				});
			},
		}),
	);

	closeManagedRepositoryResourcesForPageUnload();
	assert.equal(closeCount, 1);
	lease.release();
	closeManagedRepositoryResourcesForPageUnload();
	assert.equal(closeCount, 1);
	finishClose();
	await new Promise((resolve) => setTimeout(resolve, 0));
});

void test("aborts a pending open only after its last waiter leaves", async () => {
	const firstController = new AbortController();
	const secondController = new AbortController();
	let sharedSignal: AbortSignal | undefined;
	const open = async (signal: AbortSignal) => {
		sharedSignal = signal;
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(abortError(signal)), {
				once: true,
			});
		});
		throw new Error("unreachable");
	};

	const first = acquireManagedRepositoryResource("repository-pending", open, {
		signal: firstController.signal,
	});
	const second = acquireManagedRepositoryResource("repository-pending", open, {
		signal: secondController.signal,
	});
	firstController.abort();
	await assert.rejects(first, { name: "AbortError" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sharedSignal?.aborted, false);

	secondController.abort();
	await assert.rejects(second, { name: "AbortError" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sharedSignal?.aborted, true);
});

void test("preserves the caller's exact abort reason for a pending acquisition", async () => {
	const controller = new AbortController();
	let finishOpen!: (resource: { close: () => Promise<void> }) => void;
	const acquisition = acquireManagedRepositoryResource(
		"repository-abort-reason",
		async (): Promise<{ close: () => Promise<void> }> =>
			new Promise((resolve) => {
				finishOpen = resolve;
			}),
		{ signal: controller.signal },
	);
	const reason = "cancelled by caller";
	controller.abort(reason);

	await assert.rejects(acquisition, (error: unknown) => error === reason);
	finishOpen({ close: async () => {} });
	await new Promise((resolve) => setTimeout(resolve, 10));
});

void test("observes cancellation that occurs synchronously inside open", async () => {
	const controller = new AbortController();
	let finishOpen!: (resource: { close: () => Promise<void> }) => void;
	let openAbortReason: unknown;
	const reason = "sync abort during open";
	const resource = { close: async () => {} };
	const acquisition = acquireManagedRepositoryResource(
		"repository-sync-open-abort",
		(openSignal): Promise<typeof resource> => {
			controller.abort(reason);
			return new Promise((resolve, reject) => {
				finishOpen = resolve;
				openSignal.addEventListener(
					"abort",
					() => {
						openAbortReason = openSignal.reason;
						reject(openSignal.reason);
					},
					{ once: true },
				);
			});
		},
		{ signal: controller.signal },
	);
	const outcome = await Promise.race([
		acquisition.then(
			(lease) => ({ kind: "acquired" as const, lease }),
			(error: unknown) => ({ kind: "rejected" as const, error }),
		),
		new Promise<{ kind: "pending" }>((resolve) =>
			setTimeout(() => resolve({ kind: "pending" }), 20),
		),
	]);

	if (outcome.kind === "pending") {
		finishOpen(resource);
		(await acquisition).release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.fail("acquisition remained pending after its signal was aborted");
	}
	assert.equal(outcome.kind, "rejected");
	if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(openAbortReason instanceof DOMException);
	assert.equal(openAbortReason.name, "AbortError");
});

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted.", "AbortError");
}
