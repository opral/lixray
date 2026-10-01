import {
	openLix,
	networkFetch,
	type Lix,
	type RemoteLixFetch,
} from "@lix-js/sdk";
import { OpfsStorage } from "@lix-js/storage-opfs";

// A document is prepared before becoming editable. Its pending work is stored
// as native Lix commits, not an application snapshot or mutation outbox.
const query = new URLSearchParams(location.search);
const repoId = query.get("repositoryId") ?? "";
const branchId = query.get("branchId") ?? "";
const fileId = query.get("fileId") ?? "";
const accountId = "00000000-0000-4000-8000-000000000031";
const delayMs = Number(query.get("delayMs") ?? 0);
type Phase =
	| "closed"
	| "bootstrap"
	| "scope"
	| "ready"
	| "read"
	| "edit"
	| "failed";
let phase: Phase = "closed";
let lix: Lix | undefined;
let content = "";
let queue: Promise<unknown> = Promise.resolve();
const timings = { bootstrapMs: 0, scopeMs: 0, readyMs: 0 };
const network: {
	requestId: string;
	route: string;
	method: string;
	phase: Phase;
	status: number;
	durationMs: number;
	responseBytes: number;
	responseBytesComplete: boolean;
}[] = [];
const attempts: {
	requestId: string;
	route: string;
	method: string;
	phase: Phase;
}[] = [];
const events: { name: string; durationMs: number; outcome: string }[] = [];
let measurements: Promise<unknown>[] = [];

const fetch: RemoteLixFetch = async (input, init) => {
	const request = new Request(input, init);
	const requestId = crypto.randomUUID();
	request.headers.set("x-prototype-request-id", requestId);
	const path = new URL(request.url).pathname;
	const route = path.replace(new RegExp(`^/lix/(?:v1/)?${repoId}`), "");
	const observedPhase = phase;
	attempts.push({
		requestId,
		route,
		method: request.method,
		phase: observedPhase,
	});
	// A prepared operation must never silently resume query hydration. Native
	// publication is asynchronous and is allowed to try while offline.
	if (
		(phase === "read" || phase === "edit") &&
		(route === "" ||
			/(?:read-fulfillment|execute|admission|bootstrap|handshake|native-|\/blob|\/chunk|\/history|\/checkpoints)/.test(
				route,
			))
	)
		throw new Error(
			`Prepared native operation requested missing input: ${route}`,
		);
	const start = performance.now();
	if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
	const response = await networkFetch(request);
	const record = {
		requestId,
		route,
		method: request.method,
		phase: observedPhase,
		status: response.status,
		durationMs: performance.now() - start,
		responseBytes: 0,
		responseBytesComplete: false,
	};
	network.push(record);
	if (!response.headers.get("content-type")?.includes("event-stream")) {
		measurements.push(
			response
				.clone()
				.arrayBuffer()
				.then((bytes) => {
					record.responseBytes = bytes.byteLength;
					record.responseBytesComplete = true;
				}),
		);
	}
	return response;
};

function serialized<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const result = queue.then(async () => {
		const start = performance.now();
		try {
			const value = await operation();
			events.push({
				name,
				durationMs: performance.now() - start,
				outcome: "ok",
			});
			return value;
		} catch (error) {
			phase = "failed";
			render();
			events.push({
				name,
				durationMs: performance.now() - start,
				outcome: String(error),
			});
			throw error;
		}
	});
	queue = result.catch(() => undefined);
	return result;
}
async function readContent(): Promise<string> {
	const result = await lix!.execute(
		"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
		[fileId],
	);
	if (typeof result.rows[0]?.content !== "string")
		throw new Error("Selected document is unavailable");
	return result.rows[0].content;
}
async function closeHandle() {
	phase = "closed";
	render();
	const closing = lix;
	lix = undefined;
	await closing?.close();
}
function open() {
	return serialized("open", async () => {
		await closeHandle();
		if (
			![repoId, branchId, fileId].every((id) =>
				/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
					id,
				),
			)
		)
			throw new Error("Open a URL printed by seed-native.mjs");
		if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10_000)
			throw new Error("delayMs must be between 0 and 10000");
		const start = performance.now();
		phase = "bootstrap";
		render();
		lix = await openLix({
			storage: new OpfsStorage({
				name: `native-scope:${accountId}:${repoId}:${branchId}`,
			}),
			server: {
				url: `${location.origin}/lix/${repoId}`,
				mode: "partial_replica",
				fetch,
				headers: { Authorization: `Bearer prototype-account:${accountId}` },
			},
		});
		timings.bootstrapMs = performance.now() - start;
		phase = "scope";
		render();
		const scopeStart = performance.now();
		if ((await lix.activeBranchId()) !== branchId)
			await lix.switchBranch({ branchId });
		content = await readContent();
		await lix.prepareOfflineEditing();
		timings.scopeMs = performance.now() - scopeStart;
		timings.readyMs = performance.now() - start;
		phase = "ready";
		editor.value = content;
		render();
		return { ...timings };
	});
}
function requireReady() {
	if (phase !== "ready" || !lix)
		throw new Error("Document is not prepared for local editing");
}
function read() {
	return serialized("read", async () => {
		requireReady();
		phase = "read";
		render();
		content = await readContent();
		editor.value = content;
		phase = "ready";
		render();
		return content;
	});
}
function edit(next: string) {
	return serialized("edit", async () => {
		requireReady();
		phase = "edit";
		render();
		await lix!.execute(
			"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2",
			[next, fileId],
		);
		content = next;
		editor.value = content;
		phase = "ready";
		render();
	});
}
function close() {
	return serialized("close", closeHandle);
}
async function metrics() {
	await Promise.all(measurements);
	return {
		...timings,
		network: network.slice(),
		attempts: attempts.slice(),
		events: events.slice(),
	};
}
function resetMetrics() {
	network.length = 0;
	attempts.length = 0;
	events.length = 0;
	measurements = [];
}
function state() {
	return {
		ready: phase === "ready",
		phase,
		content,
		repoId,
		branchId,
		fileId,
		delayMs,
	};
}
const app = document.querySelector("#app")!;
app.innerHTML = `<style>body{font:16px system-ui;background:#11151b;color:#e8edf4;margin:40px}main{max-width:850px;margin:auto}textarea{width:100%;height:380px;background:#1c232c;color:inherit;padding:14px;box-sizing:border-box;font:15px monospace}button{padding:8px;margin:12px 8px 12px 0}pre{white-space:pre-wrap}</style><h1>Native document workspace</h1><p>The active document opens ready for local reading and editing. Saved work stays local when this workspace closes; synchronization runs in the background.</p><p id="status">Closed</p><textarea aria-label="Document content" disabled></textarea><button id="save" disabled>Save locally</button><button id="reopen">Reopen</button><pre id="measurements"></pre>`;
const editor = document.querySelector("textarea")!;
function render() {
	const ready = phase === "ready";
	editor.disabled = !ready;
	(document.querySelector("#save") as HTMLButtonElement).disabled = !ready;
	document.querySelector("#status")!.textContent = ready
		? "Ready for local editing"
		: phase;
	document.querySelector("#measurements")!.textContent = JSON.stringify(
		{ ...timings, requests: network.length },
		null,
		2,
	);
}
async function run(operation: () => Promise<unknown>) {
	try {
		await operation();
	} catch (error) {
		document.querySelector("#status")!.textContent = String(error);
	}
}
document
	.querySelector("#save")!
	.addEventListener("click", () => void run(() => edit(editor.value)));
document
	.querySelector("#reopen")!
	.addEventListener("click", () => void run(open));
const api = {
	open,
	reopen: open,
	read,
	edit,
	close,
	metrics,
	resetMetrics,
	state,
};
declare global {
	interface Window {
		nativePrototype: typeof api;
	}
}
window.nativePrototype = api;
void run(open);
