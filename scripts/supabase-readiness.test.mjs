import assert from "node:assert/strict";
import test from "node:test";
import { waitForSupabaseAuthDatabase } from "./supabase-readiness.mjs";

test("accepts Supabase Auth only after its database-backed admin API responds", async () => {
	let attempts = 0;
	await waitForSupabaseAuthDatabase({
		supabaseUrl: "http://127.0.0.1:54321",
		secretKey: "local-secret",
		timeoutMs: 1_000,
		pollIntervalMs: 0,
		sleep: async () => {},
		fetchImpl: async (_url, init) => {
			attempts += 1;
			assert.equal(init.headers.apikey, "local-secret");
			assert.equal(init.headers.Authorization, "Bearer local-secret");
			return attempts === 1
				? new Response("database unavailable", { status: 503 })
				: Response.json({ users: [] });
		},
	});
	assert.equal(attempts, 2);
});

test("reports the database-backed failure instead of a generic MCP error", async () => {
	await assert.rejects(
		waitForSupabaseAuthDatabase({
			supabaseUrl: "http://127.0.0.1:54321",
			secretKey: "local-secret",
			timeoutMs: 5,
			pollIntervalMs: 10,
			sleep: async () => {},
			fetchImpl: async () =>
				new Response("could not connect to database", { status: 400 }),
		}),
		/Local Supabase auth could not reach its database.*HTTP 400: could not connect to database/,
	);
});
