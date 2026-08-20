import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import app from "../dist/server/railway-server.js";
import { createRailwayServer } from "./railway-server.mjs";
import "./assert-railway-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(root, "dist/client");
const port = Number(process.env.PORT ?? 8080);

process.env.LIXRAY_JWKS_CACHE_PATH ??= join(tmpdir(), "lixray-jwks-cache.json");

try {
	await app.warmJwtVerifier(process.env);
} catch (error) {
	console.warn(
		"LixRay JWKS warmup failed; MCP will 503 until JWKS is reachable",
		error,
	);
}

const server = createRailwayServer({ app, clientRoot });

server.listen(port, "0.0.0.0", () => {
	console.log(`LixRay web service ready on 0.0.0.0:${port}`);
});
