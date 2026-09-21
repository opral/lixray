import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";
import {
	context,
	propagation,
	ROOT_CONTEXT,
	trace,
	SpanKind,
	SpanStatusCode,
} from "@opentelemetry/api";

const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_STATIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const HTML_CACHE_CONTROL = "private, no-cache";

/**
 * The Railway entry's HTTP server, extracted so request handling is
 * testable without a built `dist/server` bundle.
 */
export function createRailwayServer({ app, clientRoot, env = process.env }) {
	return createServer((incoming, outgoing) => {
		let pathname;
		try {
			pathname = new URL(incoming.url ?? "/", "http://localhost").pathname;
		} catch {
			outgoing.statusCode = 400;
			outgoing.end("Bad request\n");
			return;
		}
		if (pathname !== "/mcp") return handle(incoming, outgoing);
		const parent = propagation.extract(ROOT_CONTEXT, incoming.headers);
		const span = trace.getTracer("lixray").startSpan(
			`${incoming.method ?? "GET"} /mcp`,
			{
				kind: SpanKind.SERVER,
				attributes: {
					"http.request.method": incoming.method ?? "GET",
					"http.route": "/mcp",
				},
			},
			parent,
		);
		let ended = false;
		const failureState = {};
		const finish = (failure) => {
			if (ended) return;
			ended = true;
			span.setAttribute("http.response.status_code", outgoing.statusCode);
			failure = failureState.category ?? failure;
			if (failure || outgoing.statusCode >= 500) {
				span.setAttribute(
					"error.type",
					failure ?? `HTTP_${outgoing.statusCode}`,
				);
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end();
		};
		outgoing.once("finish", () => finish());
		outgoing.once("close", () =>
			finish(outgoing.writableFinished ? undefined : "cancelled"),
		);
		outgoing.once("error", () => finish("response_failed"));
		return context.with(trace.setSpan(parent, span), () =>
			handle(incoming, outgoing, span, failureState),
		);
	});

	async function handle(incoming, outgoing, requestSpan, failureState = {}) {
		let upstreamFailure = false;
		try {
			if (await serveStatic(clientRoot, incoming, outgoing, env)) return;
			const requestAbort = new AbortController();
			const abortDisconnectedRequest = () => requestAbort.abort();
			const abortPrematureResponseClose = () => {
				if (!outgoing.writableFinished) requestAbort.abort();
				cleanupCancellation();
			};
			const cleanupCancellation = () => {
				incoming.off("aborted", abortDisconnectedRequest);
				outgoing.off("close", abortPrematureResponseClose);
				outgoing.off("finish", cleanupCancellation);
			};
			incoming.once("aborted", abortDisconnectedRequest);
			outgoing.once("close", abortPrematureResponseClose);
			outgoing.once("finish", cleanupCancellation);

			const requestUrl = new URL(
				incoming.url ?? "/",
				`${incoming.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${incoming.headers.host ?? "localhost"}`,
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
				signal: requestAbort.signal,
			});
			let response;
			try {
				response = await app.fetch(request, env, executionContext());
				requestSpan?.addEvent("response_ready");
			} catch (error) {
				upstreamFailure = isUpstreamFetchFailure(error);
				throw error;
			}

			outgoing.statusCode = response.status;
			for (const [name, value] of response.headers) {
				outgoing.setHeader(name, value);
			}
			if (isHtmlResponse(response)) {
				// Documents select the fingerprinted asset URLs for a release. Always
				// revalidate them so a new deployment cannot keep loading an old bundle.
				// Preserve no-store when an application route requires the stricter policy.
				if (!hasCacheDirective(response, "no-store")) {
					outgoing.setHeader("cache-control", HTML_CACHE_CONTROL);
				}
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
				failureState.category = "response_body_failed";
				requestSpan?.setAttribute("error.type", "response_body_failed");
				requestSpan?.setStatus({ code: SpanStatusCode.ERROR });
				outgoing.destroy();
			});
			outgoing.on("error", () => body.destroy());
			outgoing.once("close", () => {
				if (!outgoing.writableFinished) body.destroy();
			});
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
	}
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
		response.setHeader("cache-control", staticCacheControl(pathname, filePath));
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

function hasCacheDirective(response, directive) {
	return (response.headers.get("cache-control") ?? "")
		.split(",")
		.some((value) => value.trim().toLowerCase() === directive);
}

function staticCacheControl(pathname, filePath) {
	if (extname(filePath) === ".html") return HTML_CACHE_CONTROL;
	// Vite's build assets end in an eight-character content fingerprint. Only
	// those URLs are immutable: if Lix changes, the WASM bytes and URL change
	// together. Root/public assets and unexpected names must be revalidated.
	if (/^\/assets\/.+-[A-Za-z0-9_-]{8}\.[^/]+$/.test(pathname)) {
		return IMMUTABLE_ASSET_CACHE_CONTROL;
	}
	return REVALIDATED_STATIC_CACHE_CONTROL;
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
			".wasm": "application/wasm",
			".webmanifest": "application/manifest+json",
		}[extname(path)] ?? "application/octet-stream"
	);
}
