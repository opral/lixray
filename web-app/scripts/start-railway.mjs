import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import app from "../dist/server/index.js";
import "./assert-railway-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(root, "dist/client");
const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (incoming, outgoing) => {
	try {
		if (await serveStatic(incoming, outgoing)) return;

		const requestUrl = new URL(
			incoming.url ?? "/",
			`http://${incoming.headers.host ?? "localhost"}`,
		);
		const method = incoming.method ?? "GET";
		const request = new Request(requestUrl, {
			method,
			headers: incoming.headers,
			body:
				method === "GET" || method === "HEAD"
					? undefined
					: Readable.toWeb(incoming),
			duplex: "half",
		});
		const response = await app.fetch(request, process.env, executionContext());

		outgoing.statusCode = response.status;
		for (const [name, value] of response.headers) {
			outgoing.setHeader(name, value);
		}
		if (!response.body || method === "HEAD") {
			outgoing.end();
			return;
		}
		Readable.fromWeb(response.body).pipe(outgoing);
	} catch (error) {
		console.error("LixRay request failed", error);
		if (!outgoing.headersSent) outgoing.statusCode = 500;
		outgoing.end("Internal server error\n");
	}
});

server.listen(port, "0.0.0.0", () => {
	console.log(`LixRay web service ready on 0.0.0.0:${port}`);
});

async function serveStatic(request, response) {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const pathname = new URL(
		request.url ?? "/",
		`http://${request.headers.host ?? "localhost"}`,
	).pathname;
	const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
	const filePath = resolve(clientRoot, relativePath);
	if (!filePath.startsWith(`${clientRoot}/`)) return false;

	try {
		const file = await stat(filePath);
		if (!file.isFile()) return false;
		response.statusCode = 200;
		response.setHeader("content-type", contentType(filePath));
		response.setHeader("content-length", file.size);
		if (request.method === "HEAD") response.end();
		else createReadStream(filePath).pipe(response);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function executionContext() {
	return {
		props: {},
		passThroughOnException() {},
		waitUntil(promise) {
			Promise.resolve(promise).catch((error) =>
				console.error("Background task failed", error),
			);
		},
	};
}

function contentType(path) {
	return (
		{
			".css": "text/css; charset=utf-8",
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".png": "image/png",
			".svg": "image/svg+xml",
			".webmanifest": "application/manifest+json",
		}[extname(path)] ?? "application/octet-stream"
	);
}
