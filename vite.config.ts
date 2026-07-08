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
					LIXRAY_E2E_ORG_ID:
						process.env.LIXRAY_E2E_ORG_ID ??
						config.vars?.LIXRAY_E2E_ORG_ID ??
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
