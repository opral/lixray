import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 8790);
const host = "127.0.0.1";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`;
const webServerTimeoutMs = Number(
	process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS ?? 300_000,
);

export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "compose-happy-path.spec.ts",
	timeout: 180_000,
	fullyParallel: false,
	workers: 1,
	expect: {
		timeout: 10_000,
	},
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	webServer: process.env.PLAYWRIGHT_BASE_URL
		? undefined
		: {
				command: "node ../scripts/dev.mjs",
				env: {
					...process.env,
					LIXRAY_DEV_HOST: host,
					LIXRAY_DEV_PORT: String(port),
				},
				gracefulShutdown: {
					signal: "SIGTERM",
					timeout: 45_000,
				},
				reuseExistingServer: false,
				timeout: webServerTimeoutMs,
				url: `${baseURL}/healthz`,
			},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
