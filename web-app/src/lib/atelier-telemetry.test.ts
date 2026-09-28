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
		fileId: "private-file-id",
		filePath: "/customers/acme/private-plan.MD",
		navigationCause: "foreground",
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
				view_kind: "atelier_file",
			},
		},
		{
			event: "diff_resolved",
			properties: {
				file_extension: "md",
				outcome: "accepted",
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

void test("first-file milestone uses the commit's empty-to-nonempty transition", async () => {
	const captured: Array<{
		event: string;
		properties: Record<string, unknown>;
	}> = [];
	const reported: Array<Record<string, unknown>> = [];
	const mockLix = {
		execute: async (_sql: string, params: string[]) => ({
			rows: [{ count: params[0] === "empty" ? 0 : 1 }],
		}),
	};
	const handler = createAtelierTelemetryHandler(
		(event, properties) => {
			captured.push({ event, properties });
		},
		{
			context: {
				lix: mockLix as never,
				repositoryId: "repo-123",
				organizationId: "org-456",
				reportFirstFile: async (input) => {
					reported.push(input);
				},
			},
			modificationThrottleMs: 0,
		},
	);

	handler({
		type: "document_modified",
		filePath: "/first-file.md",
		modifiedBy: "user",
		commit: { before: "empty", after: "with-file" },
	});
	handler({
		type: "document_modified",
		filePath: "/first-file.md",
		modifiedBy: "user",
		commit: { before: "with-file", after: "later" },
	});

	// Wait for async check to complete
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(
		captured.filter((event) => event.event === "first_file_added").length,
		0,
	);
	assert.deepEqual(reported, [
		{
			repositoryId: "repo-123",
			before: "empty",
			after: "with-file",
			fileExtension: "md",
			clientBeforeFileCount: 0,
			clientAfterFileCount: 1,
		},
	]);
});

void test("document loaded records measured latency without document identity", () => {
	const captured: unknown[] = [];
	const handler = createAtelierTelemetryHandler((event, properties) =>
		captured.push({ event, properties }),
	);
	handler({
		type: "document_loaded",
		fileId: "private-file-id",
		filePath: "/private/posts.csv",
		viewKind: "atelier_csv",
		durationMs: 123.5,
	});
	assert.deepEqual(captured, [
		{
			event: "document_loaded",
			properties: {
				file_extension: "csv",
				view_kind: "atelier_csv",
				duration_ms: 123.5,
			},
		},
	]);
});
