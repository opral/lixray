import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;
const MIGRATION_POLL_DELAY_MS = 1_000;
const MIGRATION_TIMEOUT_MS = 9 * 60_000;

export async function checkProductionLix({
	repositoryUrl,
	fetchImpl = globalThis.fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
	migrationTimeoutMs = MIGRATION_TIMEOUT_MS,
	nowImpl = Date.now,
	sleepImpl = sleep,
}) {
	const protocolUrl = new URL(
		`${new URL(repositoryUrl).pathname.replace(/\/$/, "")}/lix/v1/`,
		repositoryUrl,
	);
	let sessionId;
	let checkCompleted = false;
	try {
		let handshake;
		let migrationDeadline;
		for (;;) {
			const requestTimeout = migrationDeadline
				? Math.min(timeoutMs, Math.max(1, migrationDeadline - nowImpl()))
				: timeoutMs;
			handshake = await request(fetchImpl, protocolUrl, {}, requestTimeout);
			if (handshake.response.ok) break;
			if (!isMigrationInProgress(handshake)) {
				throw responseError("handshake", handshake.response, handshake.body);
			}
			migrationDeadline ??= nowImpl() + migrationTimeoutMs;
			const remaining = migrationDeadline - nowImpl();
			if (remaining <= 0) throw migrationTimeoutError(migrationTimeoutMs);
			await sleepImpl(
				Math.min(retryDelayMilliseconds(handshake.response), remaining),
			);
			if (nowImpl() >= migrationDeadline) {
				throw migrationTimeoutError(migrationTimeoutMs);
			}
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
			repository: protocolUrl.pathname.replace(/\/lix\/v1\/$/, ""),
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

function migrationTimeoutError(timeoutMs) {
	return new Error(
		`The production Lix migration did not complete within ${timeoutMs}ms.`,
	);
}

function isMigrationInProgress(result) {
	return (
		result.response.status === 503 &&
		result.body?.error?.code === "LIX_ERROR_LIX_MIGRATING"
	);
}

function retryDelayMilliseconds(response) {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(seconds * 1_000, 10_000)
		: MIGRATION_POLL_DELAY_MS;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
	const repositoryUrl =
		process.argv[2] || process.env.LIXRAY_CANARY_REPOSITORY_URL;
	if (!repositoryUrl) {
		throw new Error(
			"Pass a public repository URL or set LIXRAY_CANARY_REPOSITORY_URL.",
		);
	}
	const result = await checkProductionLix({ repositoryUrl });
	console.log(
		`Production Lix canary passed for repository ${result.repository} (protocol v${result.protocolVersion}).`,
	);
}
