import { test } from "node:test";
import assert from "node:assert/strict";
import {
	currentReplicaStorage,
	type ReplicaRoute,
} from "./repository-migration.ts";
const server = {
	url: "https://example.test/lix/00000000-0000-4000-8000-000000000001",
	headers: [] as [string, string][],
};
function environment() {
	const records = new Map<string, string>();
	let sequence = 0;
	return {
		records,
		storage: {
			getItem: (key: string) => records.get(key) ?? null,
			setItem: (key: string, value: string) => {
				records.set(key, value);
			},
		},
		exclusive: async <T>(_key: string, run: () => Promise<T>) => run(),
		createId: () => String(++sequence),
		migrate: async (options: { destinationName: string }) => ({
			destinationName: options.destinationName,
			sourceDigest: "a".repeat(64),
		}),
	};
}
await test("publishes only a validated separate destination and reopens without migration", async () => {
	const env = environment();
	const name = await currentReplicaStorage("old", server, env);
	assert.equal(name, "old:format81:1");
	env.migrate = async () => {
		throw new Error("normal opening must not migrate");
	};
	assert.equal(await currentReplicaStorage("old", server, env), name);
	const route = JSON.parse(
		env.records.get("lixray:replica-route:81:old")!,
	) as ReplicaRoute;
	assert.deepEqual(route.retainedSources, ["old"]);
});
await test("failed copy retains source and unpublished target; retry never clears them", async () => {
	const env = environment();
	const working = env.migrate;
	env.migrate = async () => {
		throw new Error("quota");
	};
	await assert.rejects(currentReplicaStorage("old", server, env), /quota/);
	assert.equal(env.records.has("lixray:replica-route:81:old"), false);
	env.migrate = working;
	assert.equal(
		await currentReplicaStorage("old", server, env),
		"old:format81:2",
	);
	assert.deepEqual(
		(
			JSON.parse(
				env.records.get("lixray:replica-route:81:old")!,
			) as ReplicaRoute
		).retainedSources,
		["old", "old:format81:1"],
	);
});
await test("mismatched receipt never publishes a store", async () => {
	const env = environment();
	env.migrate = async () => ({
		destinationName: "wrong",
		sourceDigest: "a".repeat(64),
	});
	await assert.rejects(
		currentReplicaStorage("old", server, env),
		/invalid publication receipt/,
	);
	assert.equal(env.records.has("lixray:replica-route:81:old"), false);
});
