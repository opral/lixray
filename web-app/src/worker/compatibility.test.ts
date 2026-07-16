import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";

const WEB_APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_ABORT_SIGNAL_FLAGS = [
	"enable_request_signal",
	"enable_abortsignal_rpc",
];

void test("every Worker target enables request cancellation across Durable Object RPC", async () => {
	for (const filename of [
		"wrangler.jsonc",
		"wrangler.preview.jsonc",
		"wrangler.preview-runtime.jsonc",
		"wrangler.e2e.jsonc",
	]) {
		const config = readConfig(filename);
		for (const flag of REQUIRED_ABORT_SIGNAL_FLAGS) {
			assert.ok(
				config.compatibility_flags.includes(flag),
				`${filename} must enable ${flag}`,
			);
		}
	}
});

void test("Workerd can serialize an incoming request signal over Durable Object RPC", async () => {
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
