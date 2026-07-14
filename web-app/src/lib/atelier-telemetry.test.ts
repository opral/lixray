import assert from "node:assert/strict";
import test from "node:test";
import type { AtelierEvent } from "@opral/atelier";
import {
	createAtelierTelemetryHandler,
	fileExtensionProperty,
} from "./atelier-telemetry.ts";

void test("Atelier events expose extensions and outcomes without file paths", () => {
	const captured: Array<{
		event: string;
		properties: Record<string, unknown>;
	}> = [];
	const handler = createAtelierTelemetryHandler((event, properties) => {
		captured.push({ event, properties });
	});

	handler({
		type: "document_open_attempted",
		filePath: "/customers/acme/private-plan.MD",
		documentOrigin: "existing",
		viewKind: "atelier_file",
		supported: true,
	});
	handler({
		type: "diff_resolved",
		reviewId: "private-review-id",
		filePath: "/customers/acme/private-plan.MD",
		outcome: "accepted",
	});

	assert.deepEqual(captured, [
		{
			event: "document_open_attempted",
			properties: {
				document_open_result: "viewed",
				file_extension: "md",
				document_origin: "existing",
				source: "atelier",
				view_kind: "atelier_file",
			},
		},
		{
			event: "diff_resolved",
			properties: {
				file_extension: "md",
				outcome: "accepted",
				source: "atelier",
			},
		},
	]);
	assert.equal(JSON.stringify(captured).includes("private-plan"), false);
	assert.equal(JSON.stringify(captured).includes("private-review-id"), false);
});

void test("document modifications are throttled per private path", () => {
	let now = 1_000;
	const captured: Array<string> = [];
	const handler = createAtelierTelemetryHandler(
		(event) => captured.push(event),
		{ now: () => now, modificationThrottleMs: 30_000 },
	);
	const event: AtelierEvent = {
		type: "document_modified",
		filePath: "/private/plan.md",
		modifiedBy: "user",
	};

	handler(event);
	now += 10_000;
	handler(event);
	now += 30_000;
	handler(event);

	assert.deepEqual(captured, ["document_modified", "document_modified"]);
});

void test("normalizes file extensions without retaining names", () => {
	assert.equal(fileExtensionProperty("/private/customer.PDF"), "pdf");
	assert.equal(fileExtensionProperty("/private/no-extension"), "(none)");
	assert.equal(fileExtensionProperty("/private/file.we!rd"), "werd");
});
