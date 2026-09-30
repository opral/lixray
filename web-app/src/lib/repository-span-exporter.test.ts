import assert from "node:assert/strict";
import test from "node:test";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createRepositorySpanExporter } from "./repository-span-exporter.ts";

void test("mixed-route batches retain each repository's authorization identity", () => {
	const groups: { id: string | null; spans: ReadableSpan[] }[] = [];
	const exporter = createRepositorySpanExporter(
		(id) => ({
			export(spans, callback) {
				groups.push({ id, spans });
				callback({ code: ExportResultCode.SUCCESS });
			},
			async shutdown() {},
		}),
		() => "currently-active",
	);
	const old = { attributes: { "lix.id": "old" } } as unknown as ReadableSpan;
	const next = { attributes: { "lix.id": "new" } } as unknown as ReadableSpan;
	let completed = 0;
	exporter.export([old, next, old], (result) => {
		completed++;
		assert.equal(result.code, ExportResultCode.SUCCESS);
	});
	assert.deepEqual(
		groups.map((g) => [g.id, g.spans.length]),
		[
			["old", 2],
			["new", 1],
		],
	);
	assert.equal(completed, 1);
});

void test("one failed repository export fails the batch acknowledgement", () => {
	const exporter = createRepositorySpanExporter(
		(id) => ({
			export(_spans, callback) {
				callback({
					code:
						id === "bad" ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
				});
			},
			async shutdown() {},
		}),
		() => null,
	);
	let completed = 0;
	exporter.export(
		["good", "bad"].map(
			(id) => ({ attributes: { "lix.id": id } }) as unknown as ReadableSpan,
		),
		(result) => {
			completed++;
			assert.equal(result.code, ExportResultCode.FAILED);
		},
	);
	assert.equal(completed, 1);
});
