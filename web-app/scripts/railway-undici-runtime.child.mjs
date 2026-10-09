import assert from "node:assert/strict";
import {
	createServer as createHttpServer,
	request as httpRequest,
} from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

await import(process.env.LIXRAY_UNDICI_RUNTIME_BUNDLE);

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(server.address());
		});
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function withTimeout(promise, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), 4_000);
		}),
	]).finally(() => clearTimeout(timer));
}

const scenario = process.env.LIXRAY_UNDICI_RUNTIME_SCENARIO;
if (scenario === "fin") {
	const payload = Buffer.alloc(65_536, 0x61);
	let socketClosedResolve;
	const socketClosed = new Promise((resolve) => {
		socketClosedResolve = resolve;
	});
	const server = createHttpServer((_request, response) => {
		response.socket.once("close", socketClosedResolve);
		response.writeHead(200, {
			"content-length": String(payload.length),
			connection: "close",
			"content-type": "application/octet-stream",
		});
		response.end(payload);
	});

	try {
		const address = await listen(server);
		const response = await fetch(
			new Request(`http://127.0.0.1:${address.port}/`),
		);
		assert.ok(
			response instanceof Response,
			"runtime Fetch classes share a brand",
		);
		await withTimeout(
			socketClosed,
			"server did not FIN the completed response",
		);
		// Keep the response body unread after the peer has closed its socket. This
		// lets the FIN reach the paused parser before the test resumes consumption.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const bytes = Buffer.from(await response.arrayBuffer());
		assert.equal(bytes.length, payload.length);
		assert.deepEqual(bytes, payload);
		console.log(`read ${bytes.length} bytes after FIN`);
	} finally {
		await close(server);
	}
} else if (scenario === "disconnect") {
	const { createRailwayServer } = await import("./railway-server.mjs");
	let upstreamClosedResolve;
	const upstreamClosed = new Promise((resolve) => {
		upstreamClosedResolve = resolve;
	});
	let upstreamStartedResolve;
	const upstreamStarted = new Promise((resolve) => {
		upstreamStartedResolve = resolve;
	});
	const upstream = createHttpServer((_request, response) => {
		response.once("close", upstreamClosedResolve);
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("upstream response started");
		upstreamStartedResolve();
	});
	const upstreamAddress = await listen(upstream);
	const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/held`;
	const proxy = createRailwayServer({
		app: {
			fetch(request) {
				return fetch(new Request(upstreamUrl, request));
			},
		},
		clientRoot: join(tmpdir(), "railway-no-static-client-root"),
	});
	const proxyAddress = await listen(proxy);
	const downstream = httpRequest(`http://127.0.0.1:${proxyAddress.port}/mcp`, {
		agent: false,
	});
	let downstreamResponseResolve;
	const downstreamResponse = new Promise((resolve) => {
		downstreamResponseResolve = resolve;
	});
	let downstreamDataResolve;
	const downstreamData = new Promise((resolve) => {
		downstreamDataResolve = resolve;
	});
	downstream.on("error", () => undefined);
	downstream.once("response", (response) => {
		downstreamResponseResolve(response.statusCode);
		response.once("data", (chunk) => {
			downstreamDataResolve(chunk.length);
			downstream.destroy();
		});
		response.on("error", () => undefined);
	});
	downstream.end();

	try {
		await withTimeout(
			upstreamStarted,
			"proxy did not start the upstream request",
		);
		assert.equal(
			await withTimeout(
				downstreamResponse,
				"proxy did not return upstream headers",
			),
			200,
		);
		assert.ok(
			(await withTimeout(
				downstreamData,
				"proxy did not stream upstream data",
			)) > 0,
		);
		await withTimeout(
			upstreamClosed,
			"downstream disconnect did not close the upstream response",
		);
		console.log("upstream closed after downstream disconnect");
	} finally {
		downstream.destroy();
		await Promise.all([close(proxy), close(upstream)]);
	}
} else if (scenario === "consumed-control") {
	const payload = Buffer.alloc(131_072, 0x62);
	let socketClosedResolve;
	const socketClosed = new Promise((resolve) => {
		socketClosedResolve = resolve;
	});
	const server = createHttpServer((_request, response) => {
		response.socket.once("close", socketClosedResolve);
		response.writeHead(200, {
			"content-length": String(payload.length),
			connection: "close",
			"content-type": "application/octet-stream",
		});
		response.end(payload);
	});

	try {
		const address = await listen(server);
		const response = await fetch(
			new Request(`http://127.0.0.1:${address.port}/`),
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		assert.equal(bytes.length, payload.length);
		assert.deepEqual(bytes, payload);
		await withTimeout(
			socketClosed,
			"server did not close the consumed response",
		);
		console.log(`consumed ${bytes.length} bytes before FIN`);
	} finally {
		await close(server);
	}
} else {
	throw new Error("unknown Undici runtime scenario");
}
