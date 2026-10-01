import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const input =
	process.argv[2] ??
	fileURLToPath(
		new URL("../.architecture/profile-native.json", import.meta.url),
	);
const output =
	process.argv[3] ??
	fileURLToPath(new URL("../.architecture/native-summary", import.meta.url));
const profile = JSON.parse(await readFile(input, "utf8"));
assert.equal(profile.smoke, false, "A smoke profile is not full verification");
assert.deepEqual(profile.failures, []);
assert.equal(profile.sourceAndBuildStable, true);
assert.equal(profile.build.present, true);
assert.equal(
	profile.authorityBinarySha256,
	profile.authorityBuild["authority-binary-sha256"],
);
assert.ok(profile.samples >= 6);
assert.equal(profile.workloads.length, 4);
assert.equal(
	profile.results.length,
	profile.samples * profile.workloads.length,
);
assert.equal(
	new Set(profile.results.map((row) => row.coldContextId)).size,
	profile.results.length,
);

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
};
const stats = (values) => {
	assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
	return {
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
	};
};
const rows = profile.workloads.map((workload) => {
	const results = profile.results.filter(
		(row) =>
			row.unrelatedFiles === workload.unrelatedFiles &&
			row.unrelatedHistory === workload.unrelatedHistory,
	);
	assert.equal(results.length, profile.samples);
	assert.equal(new Set(results.map((row) => row.sample)).size, profile.samples);
	for (const result of results) {
		assert.equal(result.capabilityStatus, "passed");
		assert.equal(result.bytes, 1024);
		assert.equal(result.delayMs, 80);
		assert.equal(result.convergence.status, "converged");
		assert.equal(result.finalReady, true);
		assert.equal(result.hotLocalReadMs.length, 20);
		assert.equal(result.offlineEditMs.length, 3);
		assert.equal(result.bootstrap.byteMeasurementComplete, true);
		assert.ok(result.bootstrap.knownResponseBytes <= 8192);
		assert.ok(result.bootstrap.completedResponses <= 3);
		assert.equal(result.scope.byteMeasurementComplete, true);
		assert.deepEqual(result.offlineNetwork, []);
		assert.ok(
			result.offlineAttempts.every(
				(attempt) =>
					attempt.method === "POST" && attempt.route === "/sync/push",
			),
		);
	}
	return {
		unrelatedFiles: workload.unrelatedFiles,
		unrelatedHistory: workload.unrelatedHistory,
		samples: results.length,
		bootstrapMs: stats(results.map((row) => row.bootstrapMs)),
		scopeMs: stats(results.map((row) => row.scopeMs)),
		readyMs: stats(results.map((row) => row.readyMs)),
		navigationToReadyMs: stats(results.map((row) => row.navigationToReadyMs)),
		bootstrapBytes: stats(
			results.map((row) => row.bootstrap.knownResponseBytes),
		),
		scopeBytes: stats(results.map((row) => row.scope.knownResponseBytes)),
		bootstrapResponses: stats(
			results.map((row) => row.bootstrap.completedResponses),
		),
		offlineEditMs: stats(results.flatMap((row) => row.offlineEditMs)),
		hotReadMs: stats(results.flatMap((row) => row.hotLocalReadMs)),
		offlineReopenMs: stats(results.map((row) => row.offlineEditReopenMs)),
		convergenceMs: stats(results.map((row) => row.convergence.convergenceMs)),
	};
});
const bootstrapBytes = profile.results.map(
	(row) => row.bootstrap.knownResponseBytes,
);
assert.ok(
	Math.max(...bootstrapBytes) - Math.min(...bootstrapBytes) <= 512,
	"Bootstrap response bytes grew across remote-size workloads",
);
const summary = {
	input,
	cases: profile.results.length,
	failures: 0,
	samplesPerWorkload: profile.samples,
	bootstrapByteRange: [
		Math.min(...bootstrapBytes),
		Math.max(...bootstrapBytes),
	],
	rows,
};
const ms = (value) => value.toFixed(1);
const report = `# Native working-scope verification\n\n${summary.cases}/${summary.cases} cold-browser capability cases passed. Each workload has ${profile.samples} fresh Chromium contexts and separately seeded repositories. Measured bootstrap and scope responses include an asserted 80 ms added delay. The active document is always 1 KiB. ${profile.coldAuthority ? "Authority processes restart after seeding; remote storage is reopened on the first measured repository request." : "Authority runtimes are warm after seeding."}\n\n| Unrelated files | Unrelated history writes | Bootstrap median | Scope preparation median | Ready median | Bootstrap body bytes | Scope body median |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.map((row) => `| ${row.unrelatedFiles} | ${row.unrelatedHistory} | ${ms(row.bootstrapMs.median)} ms | ${ms(row.scopeMs.median)} ms | ${ms(row.readyMs.median)} ms | ${row.bootstrapBytes.min}–${row.bootstrapBytes.max} | ${Math.round(row.scopeBytes.median)} |`).join("\n")}\n\nBootstrap completes up to three finite responses in every case and has ${summary.bootstrapByteRange[0]}–${summary.bootstrapByteRange[1]} measured body bytes across this grid. Browser assets, request bodies and headers are separate from these protocol body counts. These observations support bounded repository opening on the measured workloads; they are descriptive results, not a universal constant wall-clock guarantee or a production latency forecast.\n\nSelected-file preparation is separate and includes authenticated index dependencies and the branch write frontier. Its bytes may grow with native index depth and its time may grow with history-frontier preparation. No repository-wide offline capability is claimed.\n\n| Unrelated files / history writes | Hot read median | Offline edit median | Offline edited reopen median | Reconnect-to-authority median |\n| --- | ---: | ---: | ---: | ---: |\n${rows.map((row) => `| ${row.unrelatedFiles} / ${row.unrelatedHistory} | ${ms(row.hotReadMs.median)} ms | ${ms(row.offlineEditMs.median)} ms | ${ms(row.offlineReopenMs.median)} ms | ${ms(row.convergenceMs.median)} ms |`).join("\n")}\n\nEvery case verifies twenty prepared local reads, three offline native edits, read-after-write, durable close/reopen while offline, and authority convergence after reconnect. Successful offline protocol responses are forbidden; only native background publication attempts are allowed. Reconnect verification is outside the read/edit hot path. These are ordinary OPFS close/reopen checks, not power-loss or browser storage-eviction tests.\n`;
await writeFile(`${output}.json`, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(`${output}.md`, report);
console.log(JSON.stringify(summary));
