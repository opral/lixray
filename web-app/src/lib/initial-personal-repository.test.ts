import assert from "node:assert/strict";
import { test } from "node:test";
import type { createLix } from "@lix-js/sdk";
import { ensureInitialPersonalRepository } from "./initial-personal-repository.ts";
import type { LixraySupabaseClient } from "./supabase.ts";

const namespaceId = "87000000-0000-4000-8000-000000000010";
const repositoryId = "87000000-0000-4000-8000-000000000011";
type State = {
	namespace_id: string;
	namespace_handle: string;
	repository_id: string | null;
	repository_slug: string | null;
	needs_creation: boolean;
};

function clientFor(states: State[]) {
	let reads = 0;
	const client = {
		rpc: async (name: string) => {
			if (name === "bootstrap_personal_namespace") {
				return { data: [{ namespace_id: namespaceId }], error: null };
			}
			assert.equal(name, "initial_personal_repository_state");
			return {
				data: [states[Math.min(reads++, states.length - 1)]],
				error: null,
			};
		},
	} as unknown as LixraySupabaseClient;
	return {
		client,
		get reads() {
			return reads;
		},
	};
}

const absent: State = {
	namespace_id: namespaceId,
	namespace_handle: "opral",
	repository_id: null,
	repository_slug: null,
	needs_creation: true,
};
const present: State = {
	...absent,
	repository_id: repositoryId,
	repository_slug: "repo",
	needs_creation: false,
};

void test("creates the first personal repo through the hosted lifecycle", async () => {
	const { client } = clientFor([absent, present]);
	let calls = 0;
	const create = (async (options: Parameters<typeof createLix>[0]) => {
		calls++;
		assert.equal(options.idempotencyKey, "lixray:initial-personal-repository");
		const headers = new Headers(options.server?.headers as HeadersInit);
		assert.equal(headers.get("x-lixray-namespace-id"), namespaceId);
		assert.equal(headers.get("x-lixray-repository-name"), "repo");
		assert.equal(headers.get("x-lixray-initial-repository"), "1");
		assert.equal(headers.get("authorization"), "Bearer token");
		return { id: repositoryId };
	}) as typeof createLix;
	assert.deepEqual(
		await ensureInitialPersonalRepository(
			client,
			"token",
			"https://lixray.test",
			create,
		),
		{ path: "/@opral/repo", created: true },
	);
	assert.equal(calls, 1);
});

void test("existing and intentionally deleted repos never trigger creation", async () => {
	for (const [state, path] of [
		[present, "/@opral/repo"],
		[{ ...absent, needs_creation: false }, null],
	] as const) {
		const { client } = clientFor([state]);
		const create = (() => {
			throw new Error("unexpected creation");
		}) as typeof createLix;
		assert.deepEqual(
			await ensureInitialPersonalRepository(
				client,
				"token",
				"https://lixray.test",
				create,
			),
			{ path, created: false },
		);
	}
});

void test("uses the repo created by another tab after a name conflict", async () => {
	const { client } = clientFor([absent, present]);
	const create = (() => {
		throw new Error("name taken");
	}) as typeof createLix;
	assert.deepEqual(
		await ensureInitialPersonalRepository(
			client,
			"token",
			"https://lixray.test",
			create,
		),
		{ path: "/@opral/repo", created: false },
	);
});
