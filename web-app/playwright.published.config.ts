import { defineConfig } from "@playwright/test";
const port = Number(process.env.LIXRAY_PUBLISHED_PORT ?? 8798);
export default defineConfig({
	testDir: "./tests/published",
	timeout: 120_000,
	workers: 1,
	use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
	webServer: [
		{
			command: `pnpm exec vite --config tests/file-component/vite.config.ts --port ${port}`,
			url: `http://127.0.0.1:${port}`,
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
		},
	],
});
