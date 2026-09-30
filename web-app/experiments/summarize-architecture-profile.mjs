import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const modes = ["partial", "working-set"];
const expectedWorkloads = [
	{ bytes: 1024, unrelatedFiles: 0, delayMs: 0 },
	{ bytes: 1024, unrelatedFiles: 0, delayMs: 80 },
	{ bytes: 98304, unrelatedFiles: 0, delayMs: 80 },
	{ bytes: 1024, unrelatedFiles: 500, delayMs: 80 },
];
const metrics = [
	["coldOpenToUsableMs", "Cold open to usable (ms)"],
	["navigationToUsableMs", "Navigation to usable (ms)"],
	["prepareOfflineEditingMs", "Prepare offline editing (ms)", false],
	["offlineReopenMs", "Offline reopen before edit (ms)"],
	["offlineEditReopenMs", "Offline reopen after edit (ms)"],
	["warmReadSampleMedianMs", "Warm read median, 20 reads (ms)"],
	["durableEditMs", "Durable local edit (ms)"],
	["reconnectAttemptMs", "Reconnect sync attempt (ms)"],
	["reconnectToAuthorityMs", "Reconnect sync acknowledgment (ms; synced only)"],
	["coldRequests", "Cold protocol responses (count)", false],
	["coldResponseBytes", "Cold completed response bodies (bytes)"],
	[
		"coldIncompleteByteResponses",
		"Cold incomplete/streaming responses (count)",
		false,
	],
];

function usage() {
	return "Usage: node experiments/summarize-architecture-profile.mjs <profile.json> [summary.json] [summary.md]";
}

function workloadKey(row) {
	return JSON.stringify([row.bytes, row.unrelatedFiles, row.delayMs]);
}

function key(row) {
	return JSON.stringify([
		row.bytes,
		row.unrelatedFiles,
		row.delayMs,
		row.sample,
		row.mode,
	]);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function metricValue(result, name) {
	if (!result) return null;
	let value = result[name];
	if (name === "warmReadSampleMedianMs") {
		if (!Array.isArray(result.warmReadMs) || result.warmReadMs.length !== 20)
			return null;
		assert.ok(
			result.warmReadMs.every((item) => Number.isFinite(item) && item >= 0),
		);
		value = median(result.warmReadMs);
	}
	if (value === undefined || value === null) return null;
	assert.ok(
		Number.isFinite(value) && value >= 0,
		`${name} must be non-negative`,
	);
	return value;
}

function failureCode(error) {
	const text = String(error ?? "Unspecified failure");
	return text.match(/\bLIX_[A-Z0-9_]+\b/)?.[0] ?? text.split("\n", 1)[0];
}

function metricSummary(trials, name, ratioAllowed) {
	const values = Object.fromEntries(modes.map((mode) => [mode, new Map()]));
	for (const trial of trials) {
		const value = metricValue(trial.result, name);
		if (value !== null) values[trial.mode].set(trial.sample, value);
	}
	const partial = [...values.partial].map(([sample, value]) => ({
		sample,
		value,
	}));
	const workingSet = [...values["working-set"]].map(([sample, value]) => ({
		sample,
		value,
	}));
	const pairs = [];
	const ratios = [];
	for (let sample = 0; sample < trials.samples; sample++) {
		const p = values.partial.get(sample);
		const w = values["working-set"].get(sample);
		if (p === undefined || w === undefined) continue;
		pairs.push({ sample, partial: p, workingSet: w, difference: p - w });
		if (ratioAllowed && w > 0) ratios.push({ sample, value: p / w });
	}
	const arm = (observations) => {
		const list = observations.map((item) => item.value);
		return { n: list.length, median: median(list) };
	};
	return {
		partial: arm(partial),
		workingSet: arm(workingSet),
		pairedDifference: {
			n: pairs.length,
			median: median(pairs.map((item) => item.difference)),
			samples: pairs,
		},
		partialOverWorkingSet: {
			applicable: ratioAllowed,
			n: ratios.length,
			median: median(ratios.map((item) => item.value)),
			samples: ratios,
		},
	};
}

const [inputArgument, jsonArgument, markdownArgument] = process.argv.slice(2);
if (!inputArgument) throw new Error(usage());
const inputPath = resolve(inputArgument);
const profile = JSON.parse(await readFile(inputPath, "utf8"));
assert.ok(
	Number.isSafeInteger(profile.samples) && profile.samples >= 6,
	"Full reports require at least six samples",
);
assert.ok(
	profile.authorityBuild && profile.authorityBuild !== "smoke-unpinned",
	"Full reports require pinned build metadata",
);
assert.ok(
	profile.authorityMetadata && typeof profile.authorityMetadata === "object",
	"Missing authority metadata fields",
);
for (const [field, pattern] of Object.entries({
	"sdk-source-head": /^[a-f0-9]{40}$/,
	"sdk-diff-sha256": /^[a-f0-9]{64}$/,
	"authority-source-head": /^[a-f0-9]{40}$/,
	"authority-diff-sha256": /^[a-f0-9]{64}$/,
	"authority-binary-sha256": /^[a-f0-9]{64}$/,
	"authority-profile": /^(debug|release)$/,
}))
	assert.match(
		profile.authorityMetadata[field] ?? "",
		pattern,
		`Invalid ${field}`,
	);
assert.ok(
	Array.isArray(profile.workloads) &&
		Array.isArray(profile.results) &&
		Array.isArray(profile.failures),
);
assert.equal(
	profile.workloads.length,
	expectedWorkloads.length,
	"Expected the four declared full-profile workloads",
);
assert.deepEqual(
	[...profile.workloads].map(workloadKey).sort(),
	expectedWorkloads.map(workloadKey).sort(),
	"Profile workload plan differs from the full-profile matrix",
);

const resultsByKey = new Map();
for (const row of profile.results) {
	assert.ok(
		Number.isSafeInteger(row.sample) &&
			row.sample >= 0 &&
			row.sample < profile.samples,
	);
	assert.ok(modes.includes(row.mode));
	assert.ok(
		expectedWorkloads.some(
			(workload) => workloadKey(workload) === workloadKey(row),
		),
	);
	assert.ok(
		row.capabilityStatus === "passed" || row.capabilityStatus === "failed",
	);
	assert.ok(!resultsByKey.has(key(row)), `Duplicate result row ${key(row)}`);
	resultsByKey.set(key(row), row);
}
const failuresByKey = new Map();
for (const row of profile.failures) {
	assert.ok(
		Number.isSafeInteger(row.sample) &&
			row.sample >= 0 &&
			row.sample < profile.samples,
	);
	assert.ok(modes.includes(row.mode));
	assert.ok(
		expectedWorkloads.some(
			(workload) => workloadKey(workload) === workloadKey(row),
		),
	);
	assert.ok(!failuresByKey.has(key(row)), `Duplicate failure row ${key(row)}`);
	failuresByKey.set(key(row), row);
}

const trials = new Map();
for (const workload of expectedWorkloads) {
	for (let sample = 0; sample < profile.samples; sample++) {
		for (const mode of modes) {
			const trialKey = key({ ...workload, sample, mode });
			const result = resultsByKey.get(trialKey);
			const failure = failuresByKey.get(trialKey);
			assert.ok(result || failure, `Missing expected trial ${trialKey}`);
			if (result?.capabilityStatus === "failed")
				assert.ok(failure, `Failed result has no failure record ${trialKey}`);
			if (result?.capabilityStatus === "passed")
				assert.ok(!failure, `Passed result has a failure record ${trialKey}`);
			trials.set(trialKey, {
				...workload,
				sample,
				mode,
				result,
				failure,
				outcome: !result
					? "preColdFailure"
					: result.capabilityStatus === "passed"
						? "passed"
						: "scenarioFailed",
			});
		}
	}
}
const expectedTrialCount =
	profile.samples * expectedWorkloads.length * modes.length;
assert.equal(
	resultsByKey.size +
		[...failuresByKey.keys()].filter((item) => !resultsByKey.has(item)).length,
	expectedTrialCount,
	"Result/failure rows do not cover the complete pair plan",
);
for (const row of [...resultsByKey.values()])
	assert.ok(trials.has(key(row)), `Unexpected result ${key(row)}`);
for (const row of [...failuresByKey.values()])
	assert.ok(trials.has(key(row)), `Unexpected failure ${key(row)}`);

const workloadSummaries = expectedWorkloads.map((workload) => {
	const workloadTrials = [];
	for (let sample = 0; sample < profile.samples; sample++)
		for (const mode of modes)
			workloadTrials.push(trials.get(key({ ...workload, sample, mode })));
	workloadTrials.samples = profile.samples;
	const capabilities = Object.fromEntries(
		modes.map((mode) => {
			const armTrials = workloadTrials.filter((trial) => trial.mode === mode);
			return [
				mode,
				{
					expected: armTrials.length,
					passed: armTrials.filter((trial) => trial.outcome === "passed")
						.length,
					scenarioFailed: armTrials.filter(
						(trial) => trial.outcome === "scenarioFailed",
					).length,
					preColdFailure: armTrials.filter(
						(trial) => trial.outcome === "preColdFailure",
					).length,
				},
			];
		}),
	);
	const failures = workloadTrials
		.filter((trial) => trial.outcome !== "passed")
		.map((trial) => ({
			sample: trial.sample,
			mode: trial.mode,
			stage: trial.outcome,
			code: failureCode(trial.result?.capabilityError ?? trial.failure?.error),
		}));
	const metricSummaries = Object.fromEntries(
		metrics.map((metric) => [
			metric[0],
			metricSummary(workloadTrials, metric[0], metric[2] ?? true),
		]),
	);
	const incompleteByteResponses = workloadTrials.flatMap((trial) => {
		const count = trial.result?.coldIncompleteByteResponses ?? 0;
		return count > 0 ? [{ sample: trial.sample, mode: trial.mode, count }] : [];
	});
	const incompleteWarmReads = workloadTrials.flatMap((trial) => {
		const reads = trial.result?.warmReadMs;
		return Array.isArray(reads) && reads.length > 0 && reads.length !== 20
			? [
					{
						sample: trial.sample,
						mode: trial.mode,
						completed: reads.length,
						expected: 20,
					},
				]
			: [];
	});
	return {
		...workload,
		capabilities,
		failures,
		incompleteByteResponses,
		incompleteWarmReads,
		metrics: metricSummaries,
	};
});

const summary = {
	schemaVersion: 1,
	generatedAt: profile.generatedAt,
	sourceFile: basename(inputPath),
	samplesPerWorkload: profile.samples,
	wasmAssetIdentity: profile.wasmAssetIdentity ?? null,
	authorityBuild: profile.authorityBuild,
	authorityMetadata: profile.authorityMetadata ?? null,
	browserVersion: profile.browserVersion ?? null,
	method:
		"Medians by arm and within-sample partial-minus-working-set differences / partial-over-working-set ratios. Sample ordinals are matched across separately seeded repositories; results are descriptive with no significance claim.",
	workloads: workloadSummaries,
};

const markdown = [
	"# Architecture profile summary",
	"",
	`Source: \`${basename(inputPath)}\` · ${profile.samples} samples per workload · browser ${summary.browserVersion ?? "unknown"}`,
	`Authority: \`${summary.authorityBuild}\` · WASM: \`${summary.wasmAssetIdentity ?? "unknown"}\``,
	"",
	"Negative partial-minus-working-set differences and ratios below 1 favor partial. Per-arm medians include every observed value; paired effects use only matched sample ordinals with both values.",
];
for (const workload of workloadSummaries) {
	markdown.push(
		"",
		`## ${workload.bytes} bytes · ${workload.unrelatedFiles} unrelated files · ${workload.delayMs} ms/request delay`,
		"",
		modes
			.map((mode) => {
				const item = workload.capabilities[mode];
				return `${mode}: ${item.passed}/${item.expected} passed, ${item.scenarioFailed} post-cold scenario failures, ${item.preColdFailure} pre-cold failures`;
			})
			.join("; "),
		"",
		"| Metric | Partial median (n) | Working-set median (n) | Median Δ P−W (n) | Median P/W (n) |",
		"| --- | ---: | ---: | ---: | ---: |",
	);
	for (const [name, label] of metrics) {
		const item = workload.metrics[name];
		const unit =
			name === "coldResponseBytes"
				? "bytes"
				: ["coldRequests", "coldIncompleteByteResponses"].includes(name)
					? "count"
					: "ms";
		const fmt = (value) =>
			value === null
				? "—"
				: `${value.toFixed(unit === "ms" || !Number.isInteger(value) ? 1 : 0)} ${unit}`;
		const ratio = item.partialOverWorkingSet;
		markdown.push(
			`| ${label} | ${fmt(item.partial.median)} (${item.partial.n}) | ${fmt(item.workingSet.median)} (${item.workingSet.n}) | ${fmt(item.pairedDifference.median)} (${item.pairedDifference.n}) | ${ratio.applicable ? `${ratio.median === null ? "—" : `${ratio.median.toFixed(2)}×`} (${ratio.n})` : "N/A"} |`,
		);
	}
	if (workload.failures.length)
		markdown.push(
			"",
			`Failures: ${workload.failures.map((failure) => `${failure.mode} sample ${failure.sample}: ${failure.code}`).join("; ")}`,
		);
	markdown.push(
		"",
		`Cold byte bodies incomplete/streaming: ${workload.incompleteByteResponses.length} arm/sample(s).`,
	);
}
markdown.push(
	"",
	"Cold response bytes sum completed Lix protocol response bodies only; they exclude browser assets, requests, headers, and incomplete/streaming responses. The 80 ms delay is injected before each protocol fetch, not a full network emulator. These one-file synthetic results are not production repository E2E latency. Preparation cost is separate; working-set preparation is a no-op, so its ratio is N/A.",
	"",
);

const jsonPath = resolve(
	jsonArgument ?? inputPath.replace(/\.json$/i, "-summary.json"),
);
const markdownPath = resolve(
	markdownArgument ?? inputPath.replace(/\.json$/i, "-summary.md"),
);
await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(markdownPath, markdown.join("\n"));
console.log(markdown.join("\n"));
console.log(`\nWrote ${jsonPath} and ${markdownPath}`);
