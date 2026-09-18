import { test } from "node:test";
import assert from "node:assert/strict";
import { currentReplicaStorage } from "./repository-migration.ts";

const sourceName = "repository:old/name";
const key = `lixray:replica-route:81:${encodeURIComponent(sourceName)}`;
const route = {
	version: 1,
	activeName: `${sourceName}:format81:published`,
	sourceName,
	sourceDigest: "a".repeat(64),
	retainedSources: [sourceName, `${sourceName}:format81:interrupted`],
};
function storage(records: Map<string, string>) {
	return { getItem: (name: string) => records.get(name) ?? null };
}

void test("opens the original store through the SDK when no legacy route exists", () => {
	assert.equal(
		currentReplicaStorage(sourceName, storage(new Map())),
		sourceName,
	);
});

void test("keeps a previously published destination and retained sources unchanged", () => {
	const records = new Map([[key, JSON.stringify(route)]]);
	const before = [...records];
	assert.equal(
		currentReplicaStorage(sourceName, storage(records)),
		route.activeName,
	);
	assert.deepEqual([...records], before);
});

void test("an interrupted unpublished migration leaves the original store authoritative", () => {
	const records = new Map([
		[`${key}:staged`, JSON.stringify([`${sourceName}:format81:interrupted`])],
	]);
	const before = [...records];
	assert.equal(currentReplicaStorage(sourceName, storage(records)), sourceName);
	assert.deepEqual([...records], before);
});

void test("invalid published routes fail without falling back to stale source data", () => {
	for (const invalid of [
		null,
		{},
		{ ...route, sourceName: "other" },
		{ ...route, activeName: "other" },
		{ ...route, sourceDigest: "invalid" },
	]) {
		assert.throws(
			() =>
				currentReplicaStorage(
					sourceName,
					storage(new Map([[key, JSON.stringify(invalid)]])),
				),
			/routing metadata is invalid/,
		);
	}
	assert.throws(
		() => currentReplicaStorage(sourceName, storage(new Map([[key, "{"]]))),
		SyntaxError,
	);
});
