import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import app from "../dist/server/index.js";
import { createRailwayServer } from "./railway-server.mjs";
import "./assert-railway-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(root, "dist/client");
const port = Number(process.env.PORT ?? 8080);

const server = createRailwayServer({ app, clientRoot });

server.listen(port, "0.0.0.0", () => {
	console.log(`LixRay web service ready on 0.0.0.0:${port}`);
});
