import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
				find: "@opral/atelier/theme.css",
				replacement: at("../../../vendor/atelier/src/shell/theme.css"),
			},
			{
				find: "@opral/atelier/tailwind.css",
				replacement: at("../../../vendor/atelier/src/shell/tailwind.css"),
			},
			{
				find: "@opral/atelier/document.css",
				replacement: at("../../../vendor/atelier/src/shell/document.css"),
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
	plugins: [react(), tailwindcss()],
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: 8795,
		strictPort: true,
		fs: { allow: [at("../../../")] },
	},
});
