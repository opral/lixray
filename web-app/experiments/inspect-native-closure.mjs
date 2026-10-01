import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { seedNative } from "./seed-native.mjs";

// Inspect one fresh synthetic repository's exact-document preparation. This
// intentionally emits aggregate structure only: no repository/branch/file IDs,
// commit IDs, hashes, request descriptors, or file contents are written.
const unrelatedFiles = Number(process.env.PROTOTYPE_UNRELATED_FILES ?? 0);
assert.ok(
	Number.isSafeInteger(unrelatedFiles) && unrelatedFiles >= 0,
	"PROTOTYPE_UNRELATED_FILES must be a non-negative safe integer",
);

const previewOrigin =
	process.env.PROTOTYPE_PREVIEW_ORIGIN?.trim() || "http://127.0.0.1:8830";
const fixture = await seedNative({ bytes: 1024, unrelatedFiles });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const captured = [];
const captureErrors = [];
const pendingCaptures = [];

function countBy(items, keyFor) {
	const counts = {};
	for (const item of items) {
		const key = keyFor(item);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(
		Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
	);
}

function interestSummary(interest) {
	const fileIds = Array.isArray(interest.file_ids)
		? interest.file_ids
		: Array.isArray(interest.scope?.file_ids)
			? interest.scope.file_ids
			: [];
	const directoryIds = Array.isArray(interest.directory_ids)
		? interest.directory_ids
		: Array.isArray(interest.scope?.directory_ids)
			? interest.scope.directory_ids
			: [];
	return {
		kind: String(interest.kind ?? "unknown"),
		scope:
			interest.kind === "filesystem_paths" &&
			Array.isArray(interest.scope?.file_ids)
				? "file_ids"
				: interest.kind === "file_content"
					? "selected_file_content"
					: null,
		fileIdCount: fileIds.length,
		directoryIdCount: directoryIds.length,
		indexed: typeof interest.indexed === "boolean" ? interest.indexed : null,
		pathPredicate:
			typeof interest.path_predicate === "boolean"
				? interest.path_predicate
				: null,
		byteRange:
			typeof interest.byte_range === "boolean" ? interest.byte_range : null,
	};
}

function inputCategory(input) {
	const address = input?.address;
	const outer = typeof address?.kind === "string" ? address.kind : "unknown";
	const inner =
		typeof address?.address?.kind === "string" ? address.address.kind : null;
	return inner ? `${outer}/${inner}` : outer;
}

page.on("response", (response) => {
	if (!new URL(response.url()).pathname.endsWith("/sync/read-fulfillment"))
		return;
	const task = (async () => {
		const request = response.request();
		const requestBody = JSON.parse(request.postData() ?? "{}");
		const interests = requestBody.interests ?? [];
		const fileContentInterests = interests.filter(
			(interest) => interest.kind === "file_content",
		);
		const filesystemInterests = interests.filter(
			(interest) => interest.kind === "filesystem_paths",
		);
		assert.equal(
			fileContentInterests.length,
			1,
			"Expected one file-content interest",
		);
		assert.equal(
			filesystemInterests.length,
			1,
			"Expected one filesystem-path interest",
		);
		assert.ok(
			Array.isArray(fileContentInterests[0].file_ids) &&
				fileContentInterests[0].file_ids.length === 1 &&
				fileContentInterests[0].file_ids[0] === fixture.fileId,
			"File-content interest must name only the synthetic selected file",
		);
		const pathFileIds = filesystemInterests[0].scope?.file_ids;
		assert.ok(
			Array.isArray(pathFileIds) &&
				pathFileIds.length === 1 &&
				pathFileIds[0] === fixture.fileId,
			"Filesystem-path interest must use FileIds scope for only the selected file",
		);
		const wire = await response.body();
		const body = JSON.parse(wire.toString("utf8"));
		const inputs = Array.isArray(body.inputs) ? body.inputs : [];
		const inputSizes = inputs.map(
			(input) => Buffer.from(String(input.bytes ?? ""), "base64").byteLength,
		);
		const categoryPayloads = {};
		for (const [index, input] of inputs.entries()) {
			const category = inputCategory(input);
			const size = inputSizes[index];
			const summary = categoryPayloads[category] ?? {
				count: 0,
				decodedPayloadBytes: 0,
				maxInputBytes: 0,
			};
			summary.count += 1;
			summary.decodedPayloadBytes += size;
			summary.maxInputBytes = Math.max(summary.maxInputBytes, size);
			categoryPayloads[category] = summary;
		}
		captured.push({
			status: response.status(),
			responseJsonBytes: wire.byteLength,
			request: {
				interests: interests.map(interestSummary),
				requiredCount: requestBody.required?.length ?? 0,
				requiredKinds: countBy(requestBody.required ?? [], (item) =>
					String(item.kind ?? "unknown"),
				),
				continuationPresent: requestBody.continuation != null,
			},
			inputs: {
				count: inputs.length,
				categories: countBy(inputs, inputCategory),
				categoryPayloads: Object.fromEntries(
					Object.entries(categoryPayloads).sort(([a], [b]) =>
						a.localeCompare(b),
					),
				),
				decodedPayloadBytes: inputSizes.reduce((sum, size) => sum + size, 0),
				maxInputBytes: inputSizes.length ? Math.max(...inputSizes) : 0,
			},
			serverProfile: {
				storageCalls: Number(body.profile?.storageCalls ?? 0),
				storageBytes: Number(body.profile?.storageBytes ?? 0),
				payloadBytes: Number(body.profile?.payloadBytes ?? 0),
			},
		});
	})();
	pendingCaptures.push(
		task.catch(() => captureErrors.push("fulfillment aggregation failed")),
	);
});

try {
	try {
		await page.goto(
			`${previewOrigin}/native.html?${new URLSearchParams({
				repositoryId: fixture.repositoryId,
				branchId: fixture.branchId,
				fileId: fixture.fileId,
			})}`,
			{ waitUntil: "load", timeout: 90_000 },
		);
	} catch {
		throw new Error("Prototype preview navigation failed");
	}
	try {
		await page.waitForFunction(
			() =>
				window.nativePrototype?.state().ready ||
				window.nativePrototype?.state().phase === "failed",
			undefined,
			{ timeout: 90_000 },
		);
	} catch {
		throw new Error("Native document did not finish preparation");
	}
	const state = await page.evaluate(() => window.nativePrototype.state());
	assert.equal(
		state.ready,
		true,
		`Document preparation failed: ${state.phase}`,
	);
	assert.ok(
		state.content === "a".repeat(1024),
		"Selected synthetic file content mismatch",
	);
	await Promise.all(pendingCaptures);
	assert.deepEqual(
		captureErrors,
		[],
		"Could not safely aggregate a fulfillment response",
	);
	assert.ok(
		captured.length > 0,
		"Expected a read-fulfillment response during scope preparation",
	);
	for (const response of captured) assert.equal(response.status, 200);
	const metrics = await page.evaluate(() => window.nativePrototype.metrics());
	const phases = Object.fromEntries(
		["bootstrap", "scope"].map((phase) => {
			const completed = metrics.network.filter(
				(request) => request.phase === phase,
			);
			const attempts = metrics.attempts.filter(
				(request) => request.phase === phase,
			);
			return [
				phase,
				{
					attemptCount: attempts.length,
					responseCount: completed.length,
					responseBytes: completed.reduce(
						(sum, request) => sum + request.responseBytes,
						0,
					),
					responseBytesComplete: completed.every(
						(request) => request.responseBytesComplete,
					),
					attemptRoutes: countBy(
						attempts,
						(request) => `${request.method} ${request.route}`,
					),
					responseRoutes: countBy(
						completed,
						(request) => `${request.method} ${request.route} ${request.status}`,
					),
				},
			];
		}),
	);
	console.log(
		JSON.stringify(
			{
				fixture: {
					kind: "synthetic",
					selectedFileBytes: 1024,
					unrelatedFiles,
					selectedFileCount: 1,
				},
				timingsMs: {
					bootstrap: Number(metrics.bootstrapMs.toFixed(2)),
					scope: Number(metrics.scopeMs.toFixed(2)),
					ready: Number(metrics.readyMs.toFixed(2)),
				},
				phases,
				readFulfillment: captured.reduce(
					(aggregate, response) => {
						aggregate.responses.push(response);
						return aggregate;
					},
					{ responses: [] },
				),
				note: "Only aggregate schema/category names and counts are emitted; transient fixture IDs and all payload bytes are discarded.",
			},
			null,
			2,
		),
	);
} finally {
	await page
		.evaluate(() => window.nativePrototype?.close())
		.catch(() => undefined);
	await context.close();
	await browser.close();
}
