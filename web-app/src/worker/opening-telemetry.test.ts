import assert from "node:assert/strict";
import test from "node:test";
import { serverErrorEvents } from "./otlp-server-errors.ts";
import { repositoryOpenDiagnostics } from "../lib/repository-open-telemetry.ts";

void test("an unfinished opener's independent stall report reaches PostHog with structural correlation", async () => {
	const attribute = (key: string, value: string) => ({
		key,
		value: { stringValue: value },
	});
	const events = await serverErrorEvents({
		name: "lix.repository.open.progress",
		traceId: new Uint8Array(16).fill(1),
		spanId: new Uint8Array(8).fill(2),
		startTimeUnixNano: "1788735600123456789",
		status: { code: 2 },
		attributes: [
			attribute("lix.error.owner", "opening"),
			attribute("error.type", "LIX_OPEN_STALLED"),
			attribute("lix.id", "11111111-1111-4111-8111-111111111111"),
			attribute(
				"lix.open.operation_id",
				"22222222-2222-4222-8222-222222222222",
			),
			attribute("lix.open.phase", "storage_migrating"),
			attribute("lix.open.opener_retained", "true"),
			attribute("lix.open.dependency", "legacy_row_scan"),
			attribute("lix.open.elapsed_ms", "300000"),
			attribute("lix.open.idle_ms", "300000"),
			attribute("lix.open.rows", "32"),
			attribute("lix.open.bytes", "2048"),
			attribute("lix.open.from_format", "72"),
			attribute("lix.open.to_format", "87"),
		],
	});
	assert.equal(events.length, 1);
	assert.equal(events[0]?.properties.lix_error_code, "LIX_OPEN_STALLED");
	assert.equal(
		events[0]?.properties.openOperationId,
		"22222222-2222-4222-8222-222222222222",
	);
	assert.equal(events[0]?.properties.openPhase, "storage_migrating");
	assert.equal(events[0]?.properties.openDependency, "legacy_row_scan");
	assert.equal(events[0]?.properties.openRows, 32);
	assert.equal(events[0]?.properties.openerRetained, true);
	assert.equal(events[0]?.properties.openElapsedMs, 300000);
	assert.equal(events[0]?.properties.fromVersion, 72);
});

void test("opening diagnostics reject arbitrary dependencies, IDs and unbounded counters", () => {
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				openOperationId: "private-secret",
				openPhase: "private-query",
				openFailurePhase: "private-stack",
				openDependency: "https://private-storage",
				openRows: -1,
				openBytes: Number.MAX_SAFE_INTEGER + 1,
			},
		}),
		{},
	);
	assert.deepEqual(
		repositoryOpenDiagnostics({
			details: {
				openElapsedMs: "3000000",
				openRows: "1000000",
				openBytes: "2048000",
				openIdleMs: "99999999999999999",
				openCompletedGroups: "9007199254740992",
			},
		}),
		{
			openElapsedMs: 3000000,
			openRows: 1000000,
			openBytes: 2048000,
		},
	);
});

void test("terminal opening failures retain their failed stage without private error text", async () => {
	const attribute = (key: string, value: string) => ({
		key,
		value: { stringValue: value },
	});
	const events = await serverErrorEvents({
		name: "lix.repository.open.progress",
		traceId: new Uint8Array(16).fill(1),
		spanId: new Uint8Array(8).fill(2),
		startTimeUnixNano: "1788735600123456789",
		status: { code: 2 },
		attributes: [
			attribute("lix.error.owner", "opening"),
			attribute("error.type", "LIX_ERROR_MIGRATION_FAILED"),
			attribute("lix.open.phase", "failed"),
			attribute("lix.open.failed_phase", "engine_migrating"),
			attribute("lix.open.dependency", "engine"),
			attribute("lix.open.opener_retained", "false"),
		],
	});
	assert.equal(events.length, 1);
	assert.equal(
		events[0]?.properties.lix_error_code,
		"LIX_ERROR_MIGRATION_FAILED",
	);
	assert.equal(events[0]?.properties.openPhase, "failed");
	assert.equal(events[0]?.properties.openFailurePhase, "engine_migrating");
	assert.equal(events[0]?.properties.openerRetained, false);
});
