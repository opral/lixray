import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: "./tests/file-component",
	testMatch: "*.spec.ts",
	timeout: 30_000,
	fullyParallel: true,
	workers: 2,
	use: { baseURL: "http://127.0.0.1:8795", trace: "retain-on-failure" },
	webServer: {
		command: "pnpm exec vite --config tests/file-component/vite.config.ts",
		url: "http://127.0.0.1:8795",
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
