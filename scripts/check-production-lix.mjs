import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { getCompatibility } from "../vendor/lix/scripts/compatibility.mjs";

const REQUEST_TIMEOUT_MS = 20_000;
const ADMISSION_TIMEOUT_MS = 120_000;
const MAX_ADMISSION_ATTEMPTS = 120;
const GLOBAL_BRANCH_ID = "ffffffff-ffff-7fff-bfff-ffffffffffff";
const REPOSITORY_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
	let globalSessionId;
	let checkCompleted = false;
	try {
		const handshake = await awaitHandshake({
			fetchImpl,
			protocolUrl,
			protocolHeaders,
			timeoutMs,
			deadline: performance.now() + admissionTimeoutMs,
			sleepImpl,
		});
		// Close any allocated session even when its identity or version is wrong.
		if (
			typeof handshake.body?.sessionId === "string" &&
			handshake.body.sessionId
		) {
			sessionId = handshake.body.sessionId;
		}
		if (!handshake.response.ok)
			throw responseError("handshake", handshake.response, handshake.body);
		if (
			handshake.body?.protocolVersion !== compatibility.serverProtocolVersion ||
			handshake.body?.syncProtocolVersion !==
				compatibility.syncProtocolVersion ||
			handshake.body?.activeAccountId !== admission.principalId ||
			// The handshake carries portable repository identity. A hosted URL may
			// alias that identity after cloning/restoring; admission binds the URL.
			typeof handshake.body?.lixId !== "string" ||
			!REPOSITORY_UUID.test(handshake.body.lixId) ||
			typeof handshake.body?.sessionId !== "string" ||
			!handshake.body.sessionId ||
			typeof handshake.body?.activeBranchId !== "string" ||
			!REPOSITORY_UUID.test(handshake.body.activeBranchId)
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
		// The default handshake selects a branch, but a constant SQL query
		// cannot prove the canonical setting is readable through system tables.
		const globalUrl = new URL(protocolUrl);
		globalUrl.searchParams.set("activeBranchId", GLOBAL_BRANCH_ID);
		const global = await awaitHandshake({
			fetchImpl,
			protocolUrl: globalUrl,
			protocolHeaders,
			timeoutMs,
			deadline: performance.now() + admissionTimeoutMs,
			sleepImpl,
		});
		if (typeof global.body?.sessionId === "string" && global.body.sessionId) {
			globalSessionId = global.body.sessionId;
		}
		if (!global.response.ok)
			throw responseError("global handshake", global.response, global.body);
		if (
			!globalSessionId ||
			global.body.activeBranchId !== GLOBAL_BRANCH_ID ||
			global.body.activeAccountId !== admission.principalId ||
			global.body.lixId !== handshake.body.lixId ||
			global.body.protocolVersion !== compatibility.serverProtocolVersion ||
			global.body.syncProtocolVersion !== compatibility.syncProtocolVersion
		) {
			throw new Error(
				"The production GLOBAL handshake returned an invalid response.",
			);
		}
		const defaults = await request(
			fetchImpl,
			new URL("execute", protocolUrl),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Lix-Session-Id": globalSessionId,
					...protocolHeaders,
				},
				body: JSON.stringify({
					sql: "SELECT value FROM lix_key_value WHERE key = $1 AND lixcol_file_id IS NULL AND lixcol_untracked = false",
					params: [{ kind: "text", value: "lix_default_branch_id" }],
				}),
			},
			timeoutMs,
		);
		if (!defaults.response.ok)
			throw responseError(
				"default branch read",
				defaults.response,
				defaults.body,
			);
		const index = Array.isArray(defaults.body?.columns)
			? defaults.body.columns.findIndex((column) => column?.name === "value")
			: -1;
		const rows = defaults.body?.rows;
		const cell =
			Array.isArray(rows) && rows.length === 1 && index >= 0
				? rows[0]?.[index]
				: undefined;
		if (
			!["jsonb", "text"].includes(cell?.kind) ||
			cell?.value !== handshake.body.activeBranchId
		) {
			throw new Error(
				"The production canonical default branch is missing or disagrees with the default session.",
			);
		}
		checkCompleted = true;

		return {
			protocolVersion: handshake.body.protocolVersion,
			lix: connectionUrl.pathname,
		};
	} finally {
		let cleanupError;
		for (const allocatedSessionId of new Set(
			[globalSessionId, sessionId].filter(Boolean),
		)) {
			const close = await request(
				fetchImpl,
				new URL("session", protocolUrl),
				{
					method: "DELETE",
					headers: { "Lix-Session-Id": allocatedSessionId, ...protocolHeaders },
				},
				timeoutMs,
			).catch((error) => {
				cleanupError ??= error;
				return undefined;
			});
			if (checkCompleted && close && !close.response.ok) {
				cleanupError ??= responseError("close", close.response, close.body);
			}
		}
		if (checkCompleted && cleanupError) throw cleanupError;
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
	let openingCode = "LIX_REPOSITORY_MIGRATING";
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
		if (isRetryableOpening(admission, "LIX_REPOSITORY_MIGRATING")) {
			openingCode = admission.body.error.code;
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
		`The production Lix admission timed out waiting for ${openingCode}.`,
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
	let openingCode = "LIX_ERROR_MIGRATING";
	for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt += 1) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) break;
		const result = await request(
			fetchImpl,
			protocolUrl,
			{ headers: protocolHeaders },
			Math.min(timeoutMs, remaining),
		);
		if (!isRetryableOpening(result, "LIX_ERROR_MIGRATING")) return result;
		openingCode = result.body.error.code;
		const delay = Math.min(1_000, deadline - performance.now());
		if (delay <= 0 || attempt + 1 === MAX_ADMISSION_ATTEMPTS) break;
		await sleepImpl(delay);
	}
	throw new Error(
		`The production Lix handshake timed out waiting for ${openingCode}.`,
	);
}

function isRetryableOpening({ response, body }, legacyCode) {
	const error = body?.error;
	const details = error?.details;
	if (
		response.status !== 503 ||
		details?.retryable === false ||
		details?.stalled === true ||
		details?.openPhase === "failed"
	)
		return false;
	// Older servers report migration without retry metadata. Current opening
	// responses must explicitly authorize joining the retained opening owner.
	if (error?.code === legacyCode) return true;
	return (
		["LIX_REPOSITORY_OPENING", "LIX_OPEN_DEADLINE_EXCEEDED"].includes(
			error?.code,
		) && details?.retryable === true
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
