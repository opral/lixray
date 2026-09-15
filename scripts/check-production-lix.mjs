import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { getCompatibility } from "../vendor/lix/scripts/compatibility.mjs";

const REQUEST_TIMEOUT_MS = 20_000;
const ADMISSION_TIMEOUT_MS = 120_000;
const MAX_ADMISSION_ATTEMPTS = 120;

export async function checkProductionLix({
	lixUrl,
	fetchImpl = globalThis.fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
	admissionTimeoutMs = ADMISSION_TIMEOUT_MS,
	sleepImpl = sleep,
}) {
	const { connectionUrl, protocolUrl } = protocolUrlFromLixUrl(lixUrl);
	const compatibility = getCompatibility();
	const deadline = performance.now() + admissionTimeoutMs;
	const admission = await admitRepository({
		fetchImpl,
		protocolUrl,
		compatibility,
		timeoutMs,
		deadline,
		sleepImpl,
	});
	const protocolHeaders = {
		"lix-server-protocol-version": String(compatibility.serverProtocolVersion),
	};
	let sessionId;
	let checkCompleted = false;
	try {
		const handshake = await awaitHandshake({
			fetchImpl,
			protocolUrl,
			protocolHeaders,
			timeoutMs,
			deadline,
			sleepImpl,
		});
		if (!handshake.response.ok)
			throw responseError("handshake", handshake.response, handshake.body);
		// Close any allocated session even when its identity or version is wrong.
		if (
			typeof handshake.body?.sessionId === "string" &&
			handshake.body.sessionId
		) {
			sessionId = handshake.body.sessionId;
		}
		if (
			handshake.body?.protocolVersion !== compatibility.serverProtocolVersion ||
			handshake.body?.syncProtocolVersion !==
				compatibility.syncProtocolVersion ||
			handshake.body?.activeAccountId !== admission.principalId ||
			handshake.body?.lixId !== admission.repositoryId ||
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
					...protocolHeaders,
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
					headers: { "Lix-Session-Id": sessionId, ...protocolHeaders },
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

async function admitRepository({
	fetchImpl,
	protocolUrl,
	compatibility,
	timeoutMs,
	deadline,
	sleepImpl,
}) {
	const expectedRepositoryId = protocolUrl.pathname.split("/").at(-2);
	for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt += 1) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) break;
		const admission = await request(
			fetchImpl,
			new URL("admission", protocolUrl),
			{
				headers: {
					"lix-sync-protocol-version": String(
						compatibility.syncProtocolVersion,
					),
				},
			},
			Math.min(timeoutMs, remaining),
		);
		if (
			admission.response.status === 503 &&
			admission.body?.error?.code === "LIX_REPOSITORY_MIGRATING"
		) {
			const delay = Math.min(1_000, deadline - performance.now());
			if (delay <= 0 || attempt + 1 === MAX_ADMISSION_ATTEMPTS) break;
			await sleepImpl(delay);
			continue;
		}
		if (!admission.response.ok)
			throw responseError("admission", admission.response, admission.body);
		const identity = admission.body;
		if (
			identity?.repositoryId !== expectedRepositoryId ||
			typeof identity?.principalId !== "string" ||
			!/^[\x21-\x7e]{1,255}$/.test(identity.principalId) ||
			identity.protocolEpoch !== compatibility.syncProtocolVersion ||
			identity.storageEpoch !== compatibility.storageFormatVersion
		) {
			throw new Error(
				"The production Lix admission returned an invalid identity or compatibility epoch.",
			);
		}
		return identity;
	}
	throw new Error(
		"The production Lix admission timed out waiting for LIX_REPOSITORY_MIGRATING.",
	);
}

async function awaitHandshake({
	fetchImpl,
	protocolUrl,
	protocolHeaders,
	timeoutMs,
	deadline,
	sleepImpl,
}) {
	for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt += 1) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) break;
		const result = await request(
			fetchImpl,
			protocolUrl,
			{ headers: protocolHeaders },
			Math.min(timeoutMs, remaining),
		);
		if (
			result.response.status !== 503 ||
			result.body?.error?.code !== "LIX_ERROR_MIGRATING"
		)
			return result;
		const delay = Math.min(1_000, deadline - performance.now());
		if (delay <= 0 || attempt + 1 === MAX_ADMISSION_ATTEMPTS) break;
		await sleepImpl(delay);
	}
	throw new Error(
		"The production Lix handshake timed out waiting for LIX_ERROR_MIGRATING.",
	);
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
		throw new Error(
			"The Lix connection URL must not contain a query or fragment.",
		);
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
			cache: "no-store",
			redirect: "error",
			credentials: "omit",
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
	const lixUrl = process.argv[2] || process.env.LIXRAY_CANARY_LIX_URL;
	if (!lixUrl) {
		throw new Error("Pass a Lix connection URL or set LIXRAY_CANARY_LIX_URL.");
	}
	const result = await checkProductionLix({ lixUrl });
	console.log(
		`Production Lix canary passed for Lix ${result.lix} (protocol v${result.protocolVersion}).`,
	);
}
