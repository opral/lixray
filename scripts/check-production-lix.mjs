import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;

export async function checkProductionLix({
	lixUrl,
	fetchImpl = globalThis.fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
}) {
	const { connectionUrl, protocolUrl } = protocolUrlFromLixUrl(lixUrl);
	let sessionId;
	let checkCompleted = false;
	try {
		const handshake = await request(fetchImpl, protocolUrl, {headers: {"lix-server-protocol-version": "10"}}, timeoutMs);
		if (!handshake.response.ok) throw responseError("handshake", handshake.response, handshake.body);
		if (
			handshake.body?.protocolVersion !== 10 ||
			typeof handshake.body?.sessionId !== "string" ||
			!handshake.body.sessionId
		) {
			throw new Error(
				"The production Lix handshake returned an invalid response.",
			);
		}
		sessionId = handshake.body.sessionId;

		const execute = await request(
			fetchImpl,
			new URL("execute", protocolUrl),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Lix-Session-Id": sessionId,
					"lix-server-protocol-version": "10",
				},
				body: JSON.stringify({ sql: "SELECT 1", params: [] }),
			},
			timeoutMs,
		);
		if (!execute.response.ok) {
			throw responseError("read", execute.response, execute.body);
		}
		if (!Array.isArray(execute.body?.rows)) {
			throw new Error("The production Lix read returned an invalid response.");
		}
		checkCompleted = true;

		return {
			protocolVersion: handshake.body.protocolVersion,
			lix: connectionUrl.pathname,
		};
	} finally {
		if (sessionId) {
			const close = await request(
				fetchImpl,
				new URL("session", protocolUrl),
				{
					method: "DELETE",
					headers: { "Lix-Session-Id": sessionId, "lix-server-protocol-version": "10" },
				},
				timeoutMs,
			).catch((error) => {
				if (checkCompleted) throw error;
				return undefined;
			});
			if (checkCompleted && close && !close.response.ok) {
				throw responseError("close", close.response, close.body);
			}
		}
	}
}

export function protocolUrlFromLixUrl(value) {
	const connectionUrl = new URL(value);
	if (connectionUrl.protocol !== "https:") {
		throw new Error("The production Lix connection URL must use HTTPS.");
	}
	if (connectionUrl.username || connectionUrl.password) {
		throw new Error("The Lix connection URL must not contain credentials.");
	}
	if (connectionUrl.search || connectionUrl.hash) {
		throw new Error("The Lix connection URL must not contain a query or fragment.");
	}
	const match = connectionUrl.pathname.match(
		/^\/lix\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
	);
	if (!match) {
		throw new Error("The Lix connection URL path must be exactly /lix/{uuid}.");
	}
	const protocolUrl = new URL(connectionUrl);
	protocolUrl.pathname = `/lix/v1/${match[1]}/`;
	return { connectionUrl, protocolUrl };
}

async function request(fetchImpl, url, init, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			...init,
			signal: controller.signal,
		});
		const text = await response.text();
		let body;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = null;
		}
		return { response, body };
	} finally {
		clearTimeout(timeout);
	}
}

function responseError(operation, response, body) {
	const code =
		typeof body?.error?.code === "string" ? ` ${body.error.code}` : "";
	return new Error(
		`The production Lix ${operation} failed with HTTP ${response.status}${code}.`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const lixUrl =
		process.argv[2] || process.env.LIXRAY_CANARY_LIX_URL;
	if (!lixUrl) {
		throw new Error(
			"Pass a Lix connection URL or set LIXRAY_CANARY_LIX_URL.",
		);
	}
	const result = await checkProductionLix({ lixUrl });
	console.log(
		`Production Lix canary passed for Lix ${result.lix} (protocol v${result.protocolVersion}).`,
	);
}
