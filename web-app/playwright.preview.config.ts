import { defineConfig, devices } from "@playwright/test";

const port = 8791;

export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "preview.spec.ts",
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: `pnpm build:preview && pnpm exec wrangler dev --config dist/server/wrangler.json --port ${port}`,
		url: `http://127.0.0.1:${port}`,
		timeout: 120_000,
		reuseExistingServer: !process.env.CI,
	},
});
