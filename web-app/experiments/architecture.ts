import {
	openLix,
	networkFetch,
	HttpTransportError,
	type Lix,
	type RemoteLixFetch,
} from "@lix-js/sdk";
import { OpfsStorage } from "@lix-js/storage-opfs";
import {
	PrototypeWorkingSet,
	IndexedDbPrototypeWorkingSetStore,
	type PrototypeWorkingSetScope,
} from "../src/lib/prototype-working-set.ts";
import { createWorkingSetRemote } from "../src/lib/prototype-working-set-remote.ts";
import { repositoryOpenDiagnostics } from "../src/lib/repository-open-telemetry.ts";
import protobuf from "protobufjs/light.js";
import otlpSchema from "../src/worker/otlp-traces.schema.json" with { type: "json" };

const traceType = protobuf.Root.fromJSON(otlpSchema).lookupType(
	"opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const engineSpans: {
	name: string;
	durationMs: number;
	status: number;
	diagnostics: Record<string, string | number>;
}[] = [];
const localTelemetry = {
	onExport(request: Uint8Array) {
		const trace = traceType.toObject(traceType.decode(request), {
			longs: String,
		}) as {
			resourceSpans?: {
				scopeSpans?: {
					spans?: {
						name?: string;
						startTimeUnixNano?: string;
						endTimeUnixNano?: string;
						status?: { code?: number };
						attributes?: {
							key?: string;
							value?: { stringValue?: string; intValue?: string };
						}[];
					}[];
				}[];
			}[];
		};
		for (const resource of trace.resourceSpans ?? [])
			for (const scope of resource.scopeSpans ?? [])
				for (const span of scope.spans ?? []) {
					const diagnostics: Record<string, string | number> = {};
					for (const attribute of span.attributes ?? []) {
						if (
							!attribute.key ||
							!/^(?:error\.type|lix\.error\.code|lix\.read\.(?:recipe_count|recipe_mask)|lix\.payload\.(?:phase|failure_reason|schema_kind|recipe_mask|recipe_count|required_input_count))$/.test(
								attribute.key,
							)
						)
							continue;
						const value =
							attribute.value?.stringValue ?? attribute.value?.intValue;
						if (value !== undefined) diagnostics[attribute.key] = value;
					}
					engineSpans.push({
						name: span.name ?? "unknown",
						durationMs:
							Number(
								BigInt(span.endTimeUnixNano ?? "0") -
									BigInt(span.startTimeUnixNano ?? "0"),
							) / 1e6,
						status: span.status?.code ?? 0,
						diagnostics,
					});
				}
	},
};

type Architecture = "partial" | "working-set";
const query = new URLSearchParams(location.search);
const scope: PrototypeWorkingSetScope = {
	accountId: "00000000-0000-4000-8000-000000000031",
	repositoryId:
		query.get("repositoryId") ?? "00000000-0000-4000-8000-000000000030",
	branchId: query.get("branchId") ?? "",
	fileId: query.get("fileId") ?? "",
};
const serverUrl = `${location.origin}/lix/${scope.repositoryId}`;
const events: {
	name: string;
	durationMs: number;
	outcome: string;
	diagnostics?: Record<string, string | number | boolean | null>;
}[] = [];
const network: {
	method: string;
	route: string;
	purpose: string;
	durationMs: number;
	status: number;
	responseBytes: number;
}[] = [];
const attempts: { method: string; route: string; purpose: string }[] = [];
const measurements: Promise<unknown>[] = [];
let requestDelayMs = Number(query.get("delayMs") ?? 0);
let mode: Architecture =
	query.get("mode") === "partial" ? "partial" : "working-set";
let partial: Lix | undefined;
let remote: Promise<Lix> | undefined;
let adapter: ReturnType<typeof createWorkingSetRemote> | undefined;
let workingSet: PrototypeWorkingSet | undefined;
let displayedContent = "";
let dropNextMutationAck: string | undefined;
let foregroundOnly = false;
const store = new IndexedDbPrototypeWorkingSetStore();

async function span<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		const result = await operation();
		events.push({ name, durationMs: performance.now() - start, outcome: "ok" });
		return result;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "error";
		events.push({
			name,
			durationMs: performance.now() - start,
			outcome: code,
			diagnostics: repositoryOpenDiagnostics(error),
		});
		throw new Error(
			`${name}: ${code}: ${error instanceof Error ? error.message : "operation failed"}`,
			{ cause: error },
		);
	}
}
function measuredFetch(purpose: string): RemoteLixFetch {
	return async (input, init) => {
		const start = performance.now();
		const request = new Request(input, init);
		attempts.push({
			method: request.method,
			route: new URL(request.url).pathname.split("/").at(-1) ?? "",
			purpose,
		});
		const shouldDrop =
			dropNextMutationAck !== undefined &&
			request.headers.get("Idempotency-Key") === dropNextMutationAck;
		if (foregroundOnly)
			throw new HttpTransportError(
				"LIX_TRANSPORT_NETWORK",
				"Prototype network disconnected",
			);
		if (requestDelayMs)
			await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
		const response = await networkFetch(request);
		const record = {
			method: request.method,
			route: new URL(request.url).pathname.split("/").at(-1) ?? "",
			purpose,
			durationMs: performance.now() - start,
			status: response.status,
			responseBytes: Number(response.headers.get("content-length") ?? 0),
		};
		network.push(record);
		if (!response.headers.get("content-type")?.includes("event-stream"))
			measurements.push(
				response
					.clone()
					.arrayBuffer()
					.then((bytes) => {
						record.responseBytes = bytes.byteLength;
					})
					.catch(() => undefined),
			);
		if (shouldDrop) {
			dropNextMutationAck = undefined;
			await response.body?.cancel();
			throw new HttpTransportError(
				"LIX_TRANSPORT_NETWORK",
				"Prototype dropped accepted mutation acknowledgment",
			);
		}
		return response;
	};
}
const tracedFetch = measuredFetch("operation");
const verificationFetch = measuredFetch("verification");
// Public fixture identity only; the loopback proxy supplies server credentials.
// An explicit identity lets native local admission scope its offline evidence.
const fixtureHeaders = {
	Authorization: `Bearer prototype-account:${scope.accountId}`,
};
async function authority(): Promise<Lix> {
	remote ??= openLix({
		server: {
			url: serverUrl,
			mode: "remote",
			headers: fixtureHeaders,
			fetch: mode === "partial" ? verificationFetch : tracedFetch,
		},
	})
		.then(async (lix) => {
			if ((await lix.activeBranchId()) !== scope.branchId)
				await lix.switchBranch({ branchId: scope.branchId });
			return lix;
		})
		.catch((error: unknown) => {
			remote = undefined;
			throw error;
		});
	return remote;
}
function workingSetAuthority() {
	adapter ??= authority()
		.then((lix) => createWorkingSetRemote(lix, scope))
		.catch((error: unknown) => {
			adapter = undefined;
			throw error;
		});
	return adapter;
}
async function open(nextMode: Architecture = mode) {
	mode = nextMode;
	await close();
	return span(`${mode}.open_to_usable`, async () => {
		if (!scope.fileId || !scope.branchId)
			throw new Error(
				"Run seed-architecture.mjs and open its printed prototype URL.",
			);
		if (mode === "partial") {
			partial = await openLix({
				telemetry: localTelemetry,
				storage: new OpfsStorage({
					name: `architecture-prototype:${scope.accountId}:${scope.repositoryId}:${scope.branchId}`,
				}),
				server: {
					url: serverUrl,
					mode: "partial_replica",
					fetch: tracedFetch,
					headers: fixtureHeaders,
				},
			});
			if ((await partial.activeBranchId()) !== scope.branchId)
				await partial.switchBranch({ branchId: scope.branchId });
		} else {
			workingSet = await PrototypeWorkingSet.open({
				scope,
				store,
				remote: {
					read: async (requested) =>
						(await workingSetAuthority()).read(requested),
					compareAndSet: async (requested, operation) =>
						(await workingSetAuthority()).compareAndSet(requested, operation),
				},
			});
		}
		const content = await read();
		displayedContent = content;
		(document.querySelector("textarea") as HTMLTextAreaElement).value = content;
		document.querySelector("#status")!.textContent = `${mode}: ready`;
		return content;
	});
}
async function read(): Promise<string> {
	return span(`${mode}.read`, async () => {
		if (mode === "working-set") {
			const content = (await workingSet!.read()).content;
			if (content === null) throw new Error("Working-set cache unavailable");
			return content;
		}
		const result = await partial!.execute(
			"SELECT CAST(content AS TEXT) AS content FROM lix_file WHERE id = $1",
			[scope.fileId],
		);
		if (typeof result.rows[0]?.content !== "string")
			throw new Error("Partial file unavailable");
		return result.rows[0].content;
	});
}
async function edit(content: string) {
	return span(`${mode}.durable_edit`, async () => {
		if (mode === "working-set")
			await workingSet!.edit(content, displayedContent);
		else
			await partial!.execute(
				"UPDATE lix_file SET content = CAST($1 AS BYTEA) WHERE id = $2",
				[content, scope.fileId],
			);
		displayedContent = content;
	});
}
async function prepareOfflineEditing() {
	return span(`${mode}.prepare_offline_editing`, async () => {
		if (mode === "partial") await partial!.prepareOfflineEditing();
	});
}
async function sync() {
	return span(`${mode}.sync`, async () => {
		if (mode === "working-set") {
			const result = await workingSet!.sync();
			if (result.status === "synced") await workingSet!.refresh();
			return result;
		}
		const expected = await read();
		const deadline = performance.now() + 30_000;
		while (performance.now() < deadline) {
			if (
				(await (await workingSetAuthority()).read(scope)).content === expected
			)
				return { status: "synced" };
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(
			"Partial replica did not converge to the authority within 30 seconds",
		);
	});
}
async function close() {
	if (partial) {
		await partial.close();
		partial = undefined;
	}
	if (adapter) {
		await (await adapter).close();
		adapter = undefined;
	}
	if (remote) {
		await (await remote).close();
		remote = undefined;
	}
	workingSet = undefined;
}
const app = document.querySelector("#app")!;
app.innerHTML = `<style>body{font:16px system-ui;background:#11151b;color:#e8edf4;margin:40px}main{max-width:1000px;margin:auto}textarea{display:block;width:100%;height:420px;margin:20px 0;background:#1c232c;color:inherit;padding:14px;box-sizing:border-box;font:15px monospace}button,select{padding:8px;margin-right:8px}pre{white-space:pre-wrap}</style><h1>Lixray architecture prototype</h1><p>One text-file editing context. Both paths use the same Lix authority. Changes are confined to a disposable test repository.</p><select id="mode"><option value="working-set">Server authority + working set</option><option value="partial">Native partial replica</option></select><button id="open">Open / reopen</button><button id="save">Save locally</button><button id="sync">Synchronize</button><button id="prepare-offline">Prepare offline editing</button><p id="status">Opening…</p><textarea aria-label="File content"></textarea><pre id="metrics"></pre>`;
(document.querySelector("#mode") as HTMLSelectElement).value = mode;
function displayMetrics() {
	document.querySelector("#metrics")!.textContent = JSON.stringify(
		{ events: events.slice(-8), requests: network.length },
		null,
		2,
	);
}
async function run(action: () => Promise<unknown>) {
	try {
		await action();
	} catch (error) {
		document.querySelector("#status")!.textContent = String(error);
	}
	displayMetrics();
}
document
	.querySelector("#open")!
	.addEventListener(
		"click",
		() =>
			void run(() =>
				open(
					(document.querySelector("#mode") as HTMLSelectElement)
						.value as Architecture,
				),
			),
	);
document
	.querySelector("#save")!
	.addEventListener(
		"click",
		() =>
			void run(() =>
				edit((document.querySelector("textarea") as HTMLTextAreaElement).value),
			),
	);
document
	.querySelector("#sync")!
	.addEventListener("click", () => void run(sync));
document
	.querySelector("#prepare-offline")!
	.addEventListener("click", () => void run(prepareOfflineEditing));
const api = {
	prepareOfflineEditing,
	open,
	read,
	edit,
	sync,
	close,
	events,
	network,
	attempts,
	scope,
	metrics: async () => {
		await Promise.all(measurements);
		return {
			engineSpans: engineSpans.map((span) => ({ ...span })),
			events: events.map((event) => ({ ...event })),
			network: network.map((request) => ({ ...request })),
			attempts: attempts.map((attempt) => ({ ...attempt })),
		};
	},
	setDelay: (delay: number) => {
		requestDelayMs = delay;
	},
	setOffline: (offline: boolean) => {
		foregroundOnly = offline;
	},
	dropNextAck: async () => {
		dropNextMutationAck = (await workingSet!.read()).pending[0]?.operationId;
		if (!dropNextMutationAck)
			throw new Error("No pending mutation acknowledgment to drop");
	},
	resetCache: async () => {
		await workingSet!.resetCache();
	},
	pending: async () => workingSet?.read(),
	authorityRead: async () => (await workingSetAuthority()).read(scope),
	refresh: async () => workingSet!.refresh(),
	resolveConflict: async (content: string) => {
		await workingSet!.resolveConflict(content);
		displayedContent = content;
	},
};
(window as unknown as { __architecture: typeof api }).__architecture = api;
void run(() => open());
