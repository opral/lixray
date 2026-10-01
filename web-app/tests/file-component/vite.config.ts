import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { privateTailwind } from "../../../vendor/atelier/scripts/private-tailwind.mjs";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
	root: at("./"),
	publicDir: at("../../public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@opral/atelier/style.css",
				replacement: at("../../../vendor/atelier/src/index.css"),
			},
			{
				find: "@opral/atelier/file-icons",
				replacement: at("../../../vendor/atelier/src/file-icons.ts"),
			},
			{
				find: /^@opral\/atelier$/,
				replacement: at("../../../vendor/atelier/src/index.ts"),
			},
			{ find: "~", replacement: at("../../src") },
			{ find: "@", replacement: at("../../../vendor/atelier/src") },
		],
	},
	plugins: [react(), tailwindcss(), privateTailwind()],
	build: { cssTarget: ["chrome123", "firefox120", "safari17.5"] },
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: Number(process.env.LIXRAY_COMPONENT_PORT ?? 8795),
		strictPort: true,
		fs: { allow: [at("../../../")] },
	},
});
