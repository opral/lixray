import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";

/**
 * The Railway entry's HTTP server, extracted so request handling is
 * testable without a built `dist/server` bundle.
 */
export function createRailwayServer({ app, clientRoot, env = process.env }) {
	return createServer(async (incoming, outgoing) => {
		let upstreamFailure = false;
		try {
			if (await serveStatic(clientRoot, incoming, outgoing, env)) return;

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
			let response;
			try {
				response = await app.fetch(request, env, executionContext());
			} catch (error) {
				upstreamFailure = isUpstreamFetchFailure(error);
				throw error;
			}

			outgoing.statusCode = response.status;
			for (const [name, value] of response.headers) {
				outgoing.setHeader(name, value);
			}
			if (!response.body || method === "HEAD") {
				outgoing.end();
				return;
			}
			if (isHtmlResponse(response) && isDemoMode(env)) {
				const body = injectRuntimeConfig(await response.text());
				outgoing.setHeader("content-length", Buffer.byteLength(body));
				outgoing.end(body);
				return;
			}
			const body = Readable.fromWeb(response.body);
			// Stream failures surface as async 'error' events after this
			// handler returns; without listeners they crash the whole
			// process. A wedged upstream is a per-request problem.
			body.on("error", (error) => {
				console.error("LixRay response stream failed", error);
				outgoing.destroy();
			});
			outgoing.on("error", () => body.destroy());
			body.pipe(outgoing);
		} catch (error) {
			console.error("LixRay request failed", error);
			if (!outgoing.headersSent) {
				outgoing.statusCode = upstreamFailure ? 502 : 500;
			}
			outgoing.end(
				upstreamFailure
					? "Upstream service unavailable\n"
					: "Internal server error\n",
			);
		}
	});
}

function isUpstreamFetchFailure(error) {
	return error instanceof TypeError && error.message === "fetch failed";
}

async function serveStatic(clientRoot, request, response, env) {
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
		if (extname(filePath) === ".html" && isDemoMode(env)) {
			const body = injectRuntimeConfig(await readFile(filePath, "utf8"));
			response.setHeader("content-length", Buffer.byteLength(body));
			if (request.method === "HEAD") response.end();
			else response.end(body);
		} else {
			response.setHeader("content-length", file.size);
			if (request.method === "HEAD") response.end();
			else createReadStream(filePath).pipe(response);
		}
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function isHtmlResponse(response) {
	return response.headers.get("content-type")?.includes("text/html") ?? false;
}

function isDemoMode(env) {
	return (
		env.LIXRAY_DEMO === "1" ||
		/^(lixray-pr-[0-9]+|pr-[a-z0-9]+-[0-9]+)$/.test(
			env.RAILWAY_ENVIRONMENT_NAME ?? "",
		)
	);
}

function injectRuntimeConfig(html) {
	const marker = '<meta name="lixray-demo" content="1">';
	return html.includes(marker)
		? html
		: html.replace(/<head([^>]*)>/i, `$&${marker}`);
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
