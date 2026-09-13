import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.LIXRAY_MIGRATION_PORT ?? 8796);
export default defineConfig({
	testDir: "./tests/migration-opening",
	testMatch: "*.spec.mjs",
	timeout: 180_000,
	workers: 1,
	fullyParallel: false,
	use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
	webServer: {
		command: "pnpm exec vite --config tests/migration-opening/vite.config.mjs",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
		timeout: 60_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
