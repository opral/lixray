import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		cloudflare({
			viteEnvironment: { name: "ssr" },
			config: (config) => ({
				vars: {
					...config.vars,
					SUPABASE_JWKS_URL:
						process.env.SUPABASE_JWKS_URL ?? config.vars?.SUPABASE_JWKS_URL,
					SUPABASE_PUBLISHABLE_KEY:
						process.env.SUPABASE_PUBLISHABLE_KEY ??
						config.vars?.SUPABASE_PUBLISHABLE_KEY,
					SUPABASE_URL: process.env.SUPABASE_URL ?? config.vars?.SUPABASE_URL,
					LIXRAY_E2E_WORKSPACE_ID:
						process.env.LIXRAY_E2E_WORKSPACE_ID ??
						config.vars?.LIXRAY_E2E_WORKSPACE_ID ??
						"",
					SLATEDB_STORAGE:
						process.env.SLATEDB_STORAGE ?? config.vars?.SLATEDB_STORAGE ?? "r2",
				},
			}),
		}),
		tailwindcss(),
		tanstackStart(),
		react(),
	],
});
