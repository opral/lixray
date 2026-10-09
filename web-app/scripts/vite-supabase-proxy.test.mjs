import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import test from "node:test";

const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const proxyRoutes = [
	"/auth",
	"/rest",
	"/storage",
	"/realtime",
	"/functions",
	"/graphql",
];
const environmentKeys = ["VITE_SUPABASE_URL", "SUPABASE_URL"];

async function loadProxyTargets(values) {
	const previous = Object.fromEntries(
		environmentKeys.map((key) => [key, process.env[key]]),
	);
	for (const key of environmentKeys) {
		if (values[key] === undefined) delete process.env[key];
		else process.env[key] = values[key];
	}
	try {
		const { config } = await loadConfigFromFile(
			{ command: "serve", mode: "development" },
			configFile,
		);
		return Object.fromEntries(
			proxyRoutes.map((route) => [route, config.server.proxy[route].target]),
		);
	} finally {
		for (const key of environmentKeys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

test("all local Supabase Vite proxies use the configured URL", async () => {
	assert.deepEqual(
		await loadProxyTargets({
			VITE_SUPABASE_URL: "http://127.0.0.1:49876/",
			SUPABASE_URL: "http://127.0.0.1:41000",
		}),
		Object.fromEntries(
			proxyRoutes.map((route) => [route, "http://127.0.0.1:49876"]),
		),
	);
	assert.deepEqual(
		await loadProxyTargets({ SUPABASE_URL: "http://127.0.0.1:41000" }),
		Object.fromEntries(
			proxyRoutes.map((route) => [route, "http://127.0.0.1:41000"]),
		),
	);
	assert.deepEqual(
		await loadProxyTargets({}),
		Object.fromEntries(
			proxyRoutes.map((route) => [route, "http://127.0.0.1:54321"]),
		),
	);
});
