import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;

export async function checkProductionLix({
	workspaceUrl,
	fetchImpl = globalThis.fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
}) {
	const protocolUrl = new URL(
		`${new URL(workspaceUrl).pathname.replace(/\/$/, "")}/lix/v1/`,
		workspaceUrl,
	);
	let sessionId;
	let checkCompleted = false;
	try {
		const handshake = await request(fetchImpl, protocolUrl, {}, timeoutMs);
		if (!handshake.response.ok) {
			throw responseError("handshake", handshake.response, handshake.body);
		}
		if (
			typeof handshake.body?.protocolVersion !== "number" ||
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
			workspace: protocolUrl.pathname.replace(/\/lix\/v1\/$/, ""),
		};
	} finally {
		if (sessionId) {
			const close = await request(
				fetchImpl,
				new URL("session", protocolUrl),
				{
					method: "DELETE",
					headers: { "Lix-Session-Id": sessionId },
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
	const workspaceUrl =
		process.argv[2] || process.env.LIXRAY_CANARY_WORKSPACE_URL;
	if (!workspaceUrl) {
		throw new Error(
			"Pass a public repository URL or set LIXRAY_CANARY_WORKSPACE_URL.",
		);
	}
	const result = await checkProductionLix({ workspaceUrl });
	console.log(
		`Production Lix canary passed for repository ${result.workspace} (protocol v${result.protocolVersion}).`,
	);
}
