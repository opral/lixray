import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig } from "vite";

const useE2eWorkerConfig =
	process.env.VITE_LIXRAY_E2E === "1" || process.env.LIXRAY_E2E_SERVER === "1";
const usePreviewWorkerConfig = process.env.VITE_LIXRAY_PREVIEW === "1";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		cloudflare({
			configPath: usePreviewWorkerConfig
				? "./wrangler.preview.jsonc"
				: useE2eWorkerConfig
					? "./wrangler.e2e.jsonc"
					: "./wrangler.jsonc",
			viteEnvironment: { name: "ssr" },
			...(usePreviewWorkerConfig
				? {}
				: {
						config: (config) => ({
							vars: {
								...config.vars,
								SUPABASE_JWKS_URL:
									process.env.SUPABASE_JWKS_URL ??
									config.vars?.SUPABASE_JWKS_URL,
								SUPABASE_PUBLISHABLE_KEY:
									process.env.SUPABASE_PUBLISHABLE_KEY ??
									config.vars?.SUPABASE_PUBLISHABLE_KEY,
								SUPABASE_URL:
									process.env.SUPABASE_URL ?? config.vars?.SUPABASE_URL,
								LIXRAY_E2E_WORKSPACE_ID:
									process.env.LIXRAY_E2E_WORKSPACE_ID ??
									config.vars?.LIXRAY_E2E_WORKSPACE_ID ??
									"",
								LIXRAY_E2E_WORKSPACE_IDS:
									process.env.LIXRAY_E2E_WORKSPACE_IDS ??
									config.vars?.LIXRAY_E2E_WORKSPACE_IDS ??
									"",
								SLATEDB_STORAGE:
									process.env.SLATEDB_STORAGE ??
									config.vars?.SLATEDB_STORAGE ??
									"r2",
							},
						}),
					}),
		}),
		tailwindcss(),
		tanstackStart(),
		react(),
	],
});
