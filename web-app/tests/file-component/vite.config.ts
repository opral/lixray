import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
	root: at("./"),
	publicDir: at("../../public"),
	resolve: {
		alias: {
			"~": at("../../src"),
			"@": at("../../../vendor/atelier/src"),
			"@opral/atelier/style.css": at("../../../vendor/atelier/src/index.css"),
			"@opral/atelier/file-icons": at(
				"../../../vendor/atelier/src/file-icons.ts",
			),
			"@opral/atelier": at("../../../vendor/atelier/src/index.ts"),
		},
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
