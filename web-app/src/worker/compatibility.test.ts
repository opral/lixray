import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";

const WEB_APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUEST_SIGNAL_FLAG = "enable_request_signal";
const EXPERIMENTAL_RPC_FLAG = "enable_abortsignal_rpc";

void test("every Worker target enables request cancellation without experimental RPC flags", async () => {
	for (const filename of [
		"wrangler.jsonc",
		"wrangler.preview.jsonc",
		"wrangler.preview-runtime.jsonc",
		"wrangler.e2e.jsonc",
	]) {
		const config = readConfig(filename);
		assert.ok(
			config.compatibility_flags.includes(REQUEST_SIGNAL_FLAG),
			`${filename} must enable ${REQUEST_SIGNAL_FLAG}`,
		);
		assert.equal(
			config.compatibility_flags.includes(EXPERIMENTAL_RPC_FLAG),
			false,
			`${filename} cannot deploy with ${EXPERIMENTAL_RPC_FLAG}`,
		);
	}
});

void test("Workerd keeps the request signal local to deployable Durable Object RPC", async () => {
	const productionConfig = readConfig("wrangler.jsonc");
	const fixtureConfig = fileURLToPath(
		new URL("./fixtures/wrangler.abort-signal-rpc.jsonc", import.meta.url),
	);
	const fixtureCompatibility = readConfig(
		"src/worker/fixtures/wrangler.abort-signal-rpc.jsonc",
	);
	assert.equal(
		fixtureCompatibility.compatibility_date,
		productionConfig.compatibility_date,
	);
	assert.deepEqual(
		fixtureCompatibility.compatibility_flags,
		productionConfig.compatibility_flags,
	);
	const worker = await unstable_startWorker({
		config: fixtureConfig,
		dev: { persist: false, server: { port: 0 } },
	});

	try {
		await worker.ready;
		const response = await worker.fetch("https://worker.test/");
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			isAbortSignal: true,
			aborted: false,
		});
	} finally {
		await worker.dispose();
	}
});

interface WranglerCompatibilityConfig {
	compatibility_date: string;
	compatibility_flags: Array<string>;
}

function readConfig(filename: string): WranglerCompatibilityConfig {
	return unstable_readConfig(
		{ config: `${WEB_APP_ROOT}/${filename}` },
		{ hideWarnings: true },
	) as WranglerCompatibilityConfig;
}
