import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "./tests/published",
	timeout: 120_000,
	workers: 1,
	use: { baseURL: "http://127.0.0.1:8798", trace: "retain-on-failure" },
	webServer: [
		{
			command:
				"pnpm exec vite --config tests/file-component/vite.config.ts --port 8798",
			url: "http://127.0.0.1:8798",
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
		},
	],
});
