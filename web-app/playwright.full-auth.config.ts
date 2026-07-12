import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_FULL_AUTH_PORT ?? 8791);
const host = "localhost";
const baseURL = `http://${host}:${port}`;

export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "full-auth.spec.ts",
	timeout: 180_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	globalTeardown: "./tests/e2e/global-teardown.ts",
	webServer: {
		command: "node ../scripts/dev.mjs",
		env: {
			...process.env,
			LIXRAY_DEV_HOST: host,
			LIXRAY_DEV_PORT: String(port),
			LIXRAY_E2E_SERVER: "1",
			SLATEDB_STORAGE: "memory",
		},
		reuseExistingServer: false,
		timeout: 300_000,
		url: `${baseURL}/healthz`,
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
