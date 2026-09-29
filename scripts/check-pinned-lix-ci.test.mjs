import assert from "node:assert/strict";
import test from "node:test";
import {
	checkPinnedLixCi,
	selectSuccessfulArtifact,
} from "./check-pinned-lix-ci.mjs";

const revision = "a".repeat(40);
const artifact = {
	id: 42,
	expired: false,
	workflow_run: { id: 7, head_sha: revision },
};
const run = (status, conclusion) => ({
	id: 7,
	path: ".github/workflows/ci.yml",
	head_sha: revision,
	head_repository: { full_name: "opral/lix" },
	status,
	conclusion,
});

test("a producer must finish successfully before its artifact can gate a pin", () => {
	assert.equal(
		selectSuccessfulArtifact(
			[artifact],
			new Map([[7, run("in_progress", null)]]),
			revision,
		),
		undefined,
	);
	assert.equal(
		selectSuccessfulArtifact(
			[artifact],
			new Map([[7, run("completed", "failure")]]),
			revision,
		),
		undefined,
	);
	assert.equal(
		selectSuccessfulArtifact(
			[artifact],
			new Map([[7, run("completed", "success")]]),
			revision,
		)?.artifact.id,
		42,
	);
});

test("local preflight stops before expensive checks when the pinned producer failed", async () => {
	const paths = [];
	const api = (path) => {
		paths.push(path);
		return path.includes("artifacts?")
			? { artifacts: [artifact] }
			: run("completed", "failure");
	};
	await assert.rejects(
		checkPinnedLixCi({
			api,
			git: () => `160000 commit ${revision}\tvendor/lix`,
			log: () => {},
		}),
		/no browser artifact from completed successful CI/,
	);
	assert.equal(paths.length, 2);
});

test("CI waits for the exact producer artifact to finish publishing", async () => {
	let clock = 0;
	let artifactPolls = 0;
	const logs = [];
	const api = (path) => {
		if (path.includes("artifacts?")) {
			artifactPolls++;
			return { artifacts: artifactPolls === 1 ? [] : [artifact] };
		}
		if (path.includes("workflows/ci.yml/runs?")) {
			return { workflow_runs: [run("in_progress", null)] };
		}
		return run("completed", "success");
	};
	const result = await checkPinnedLixCi({
		api,
		git: () => `160000 commit ${revision}\tvendor/lix`,
		log: (message) => logs.push(message),
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		waitMs: 60_000,
		pollMs: 20_000,
	});
	assert.deepEqual(result, { revision, runId: 7, artifactId: 42 });
	assert.equal(artifactPolls, 2);
	assert.match(logs[0], /Waiting for successful Lix CI/);
});

test("CI stops early when the exact producer run has failed", async () => {
	let slept = false;
	await assert.rejects(
		checkPinnedLixCi({
			api: (path) =>
				path.includes("artifacts?")
					? { artifacts: [] }
					: { workflow_runs: [run("completed", "failure")] },
			git: () => `160000 commit ${revision}\tvendor/lix`,
			log: () => {},
			sleep: async () => {
				slept = true;
			},
			waitMs: 60_000,
		}),
		/CI failed/,
	);
	assert.equal(slept, false);
});
