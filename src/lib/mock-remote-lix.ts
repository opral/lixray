import type {
	CreateBranchOptions,
	CreateBranchReceipt,
	ExecuteOptions,
	ExecuteResult,
	Lix,
	MergeBranchPreview,
	MergeBranchReceipt,
	ObserveEvent,
	SqlParam,
	SwitchBranchOptions,
	SwitchBranchReceipt,
} from "@lix-js/sdk";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import type { Branch, ExecuteResponse, WireValue } from "./lixray-api";

type TokenProvider = () => Promise<string | null>;

export interface OpenMockRemoteLixOptions {
	workspaceId: string;
	getAccessToken: TokenProvider;
	fetch?: typeof fetch;
}

interface BranchesPayload {
	branches: Branch[];
}

interface ObservePayload {
	sequence: number;
	mutationSequence: number;
	result: ExecuteResponse;
}

interface SseFrame {
	event: string;
	data: string;
}

interface ObserveClock {
	sequence: number;
	mutationSequence: number;
}

type ObserveWaiter = {
	resolve: (event: ObserveEvent | undefined) => void;
	reject: (error: unknown) => void;
};

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBSERVATION_HUB_SQL =
	"SELECT id FROM lix_change ORDER BY created_at DESC, id DESC LIMIT 1";

/**
 * Opens the deliberately thin first version of a browser Lix session.
 *
 * The returned object implements the SDK surface Atelier currently uses while
 * delegating all canonical data and observations to LixRay's SlateDB-backed
 * workspace API. One SSE mutation feed fans out into REST query refreshes so
 * Atelier cannot exhaust the browser's per-origin connection pool.
 */
export async function openMockRemoteLix(
	options: OpenMockRemoteLixOptions,
): Promise<Lix> {
	const client = new MockRemoteLix(options);
	await client.initialize();
	return client as unknown as Lix;
}

class MockRemoteLix {
	readonly #workspaceId: string;
	readonly #getAccessToken: TokenProvider;
	readonly #fetch: typeof fetch;
	readonly #observers = new Set<MockRemoteObserveEvents>();
	#activeBranchId = "";
	#observationController: AbortController | undefined;
	#observationGeneration = 0;
	#observationClock: ObserveClock = { sequence: 0, mutationSequence: 0 };
	#closed = false;

	constructor(options: OpenMockRemoteLixOptions) {
		if (!UUID_PATTERN.test(options.workspaceId)) {
			throw new TypeError("A valid workspace UUID is required");
		}
		this.#workspaceId = options.workspaceId;
		this.#getAccessToken = options.getAccessToken;
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	async initialize(): Promise<void> {
		const branches = await this.#listBranches();
		const initial =
			branches.find((branch) => !branch.hidden && branch.name === "main") ??
			branches.find((branch) => !branch.hidden) ??
			branches[0];
		if (!initial) {
			throw new MockRemoteLixError(
				"LIX_BRANCH_NOT_FOUND",
				"The workspace does not contain a branch.",
			);
		}
		this.#activeBranchId = initial.id;
	}

	async execute(
		sql: string,
		params: SqlParam[] = [],
		options?: ExecuteOptions,
	): Promise<ExecuteResult> {
		this.#assertOpen();
		const payload = await this.#requestJson<ExecuteResponse>("/execute", {
			method: "POST",
			body: JSON.stringify({
				branchId: this.#activeBranchId,
				sql,
				params: params.map((param) => sqlParamToWireValue(param)),
				...(options?.originKey
					? { options: { originKey: options.originKey } }
					: {}),
			}),
		});
		return executeResponseToResult(payload);
	}

	observe(sql: string, params: SqlParam[] = []): MockRemoteObserveEvents {
		this.#assertOpen();
		const observer = new MockRemoteObserveEvents(
			() => this.execute(sql, params),
			() => {
				this.#observers.delete(observer);
				if (this.#observers.size === 0) this.#stopObservationHub();
			},
		);
		this.#observers.add(observer);
		observer.refresh(this.#observationClock);
		this.#startObservationHub();
		return observer;
	}

	activeBranchId(): Promise<string> {
		this.#assertOpen();
		return Promise.resolve(this.#activeBranchId);
	}

	async createBranch(
		options: CreateBranchOptions,
	): Promise<CreateBranchReceipt> {
		this.#assertOpen();
		const receipt = await this.#requestJson<CreateBranchReceipt>(
			"/createBranch",
			{
				method: "POST",
				body: JSON.stringify({
					branchId: this.#activeBranchId,
					...(options.id ? { id: options.id } : {}),
					name: options.name,
					...(options.fromCommitId
						? { fromCommitId: options.fromCommitId }
						: {}),
				}),
			},
		);
		this.#activeBranchId = receipt.id;
		this.#restartObservers();
		return receipt;
	}

	async switchBranch(
		options: SwitchBranchOptions,
	): Promise<SwitchBranchReceipt> {
		this.#assertOpen();
		const branches = await this.#listBranches();
		if (!branches.some((branch) => branch.id === options.branchId)) {
			throw new MockRemoteLixError(
				"LIX_BRANCH_NOT_FOUND",
				`Branch not found: ${options.branchId}`,
			);
		}
		this.#activeBranchId = options.branchId;
		this.#restartObservers();
		return { branchId: options.branchId };
	}

	beginTransaction(): Promise<never> {
		return Promise.reject(unsupportedOperation("beginTransaction"));
	}

	mergeBranchPreview(): Promise<MergeBranchPreview> {
		return Promise.reject(unsupportedOperation("mergeBranchPreview"));
	}

	mergeBranch(): Promise<MergeBranchReceipt> {
		return Promise.reject(unsupportedOperation("mergeBranch"));
	}

	close(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#closed = true;
		this.#stopObservationHub();
		for (const observer of [...this.#observers]) observer.close();
		this.#observers.clear();
		return Promise.resolve();
	}

	async #listBranches(): Promise<Branch[]> {
		const payload = await this.#requestJson<BranchesPayload>("/branches");
		return payload.branches;
	}

	async #requestJson<T>(
		endpoint: string,
		init: RequestInit = {},
		signal?: AbortSignal,
	): Promise<T> {
		this.#assertOpen();
		const response = await this.#request(endpoint, init, signal);
		return response.json();
	}

	async #request(
		endpoint: string,
		init: RequestInit,
		signal?: AbortSignal,
	): Promise<Response> {
		const token = await this.#getAccessToken();
		if (!token) {
			throw new MockRemoteLixError(
				"LIX_UNAUTHORIZED",
				"No access token is available for this workspace.",
			);
		}
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (init.body) headers.set("content-type", "application/json");

		const response = await this.#fetch(
			workspaceApiPath(this.#workspaceId, endpoint),
			{ ...init, headers, signal },
		);
		if (!response.ok) throw await responseError(response);
		return response;
	}

	async #openObservationHub(
		branchId: string,
		signal: AbortSignal,
	): Promise<Response> {
		return this.#request(
			"/observe",
			{
				method: "POST",
				headers: { Accept: "text/event-stream" },
				body: JSON.stringify({
					branchId,
					sql: OBSERVATION_HUB_SQL,
					params: [],
				}),
			},
			signal,
		);
	}

	#startObservationHub(): void {
		if (
			this.#closed ||
			this.#observers.size === 0 ||
			this.#observationController
		) {
			return;
		}
		const generation = this.#observationGeneration;
		const branchId = this.#activeBranchId;
		const controller = new AbortController();
		this.#observationController = controller;
		void this.#consumeObservationHub(branchId, generation, controller);
	}

	#stopObservationHub(): void {
		this.#observationGeneration += 1;
		this.#observationController?.abort();
		this.#observationController = undefined;
	}

	async #consumeObservationHub(
		branchId: string,
		generation: number,
		controller: AbortController,
	): Promise<void> {
		try {
			const response = await this.#openObservationHub(
				branchId,
				controller.signal,
			);
			if (!this.#isCurrentObservationHub(generation, controller)) return;
			if (!response.body) {
				throw new MockRemoteLixError(
					"LIX_OBSERVE_UNAVAILABLE",
					"The observation response has no body.",
				);
			}
			for await (const frame of readSseFrames(response.body)) {
				if (!this.#isCurrentObservationHub(generation, controller)) return;
				if (frame.event === "next") {
					const payload = JSON.parse(frame.data) as ObservePayload;
					this.#observationClock = {
						sequence: payload.sequence,
						mutationSequence: payload.mutationSequence,
					};
					for (const observer of this.#observers) {
						observer.refresh(this.#observationClock);
					}
				} else if (frame.event === "error") {
					throw eventError(frame.data);
				}
			}
			if (this.#isCurrentObservationHub(generation, controller)) {
				throw new MockRemoteLixError(
					"LIX_OBSERVE_UNAVAILABLE",
					"The workspace observation stream ended.",
				);
			}
		} catch (error) {
			await yieldToBrowserTask();
			if (
				!this.#isCurrentObservationHub(generation, controller) ||
				isAbortError(error)
			) {
				return;
			}
			for (const observer of this.#observers) observer.fail(error);
		} finally {
			if (this.#isCurrentObservationHub(generation, controller)) {
				this.#observationController = undefined;
			}
		}
	}

	#isCurrentObservationHub(
		generation: number,
		controller: AbortController,
	): boolean {
		return (
			!this.#closed &&
			generation === this.#observationGeneration &&
			controller === this.#observationController
		);
	}

	#restartObservers(): void {
		this.#stopObservationHub();
		this.#observationClock = { sequence: 0, mutationSequence: 0 };
		for (const observer of this.#observers) {
			observer.restart(this.#observationClock);
		}
		this.#startObservationHub();
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new MockRemoteLixError("LIX_CLOSED", "The remote Lix is closed.");
		}
	}
}

class MockRemoteObserveEvents {
	readonly #execute: () => Promise<ExecuteResult>;
	readonly #onClose: () => void;
	#events: ObserveEvent[] = [];
	#waiters: ObserveWaiter[] = [];
	#error: Error | undefined;
	#closed = false;
	#generation = 0;
	#refreshId = 0;

	constructor(execute: () => Promise<ExecuteResult>, onClose: () => void) {
		this.#execute = execute;
		this.#onClose = onClose;
	}

	next(): Promise<ObserveEvent | undefined> {
		if (this.#events.length > 0) {
			return Promise.resolve(this.#events.shift());
		}
		if (this.#error !== undefined) return Promise.reject(this.#error);
		if (this.#closed) return Promise.resolve(undefined);
		return new Promise<ObserveEvent | undefined>((resolve, reject) => {
			this.#waiters.push({ resolve, reject });
		});
	}

	refresh(clock: ObserveClock): void {
		if (this.#closed) return;
		this.#error = undefined;
		const generation = this.#generation;
		const refreshId = ++this.#refreshId;
		void this.#load(generation, refreshId, clock);
	}

	restart(clock: ObserveClock): void {
		if (this.#closed) return;
		this.#generation += 1;
		this.#refreshId += 1;
		this.#events = [];
		this.#error = undefined;
		this.refresh(clock);
	}

	fail(error: unknown): void {
		if (this.#closed) return;
		this.#fail(error);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#generation += 1;
		this.#refreshId += 1;
		for (const waiter of this.#waiters.splice(0)) waiter.resolve(undefined);
		this.#events = [];
		this.#onClose();
	}

	async #load(
		generation: number,
		refreshId: number,
		clock: ObserveClock,
	): Promise<void> {
		try {
			const result = await this.#execute();
			if (!this.#isCurrent(generation, refreshId)) return;
			this.#push({ ...clock, result });
		} catch (error) {
			await yieldToBrowserTask();
			if (!this.#isCurrent(generation, refreshId)) return;
			this.#fail(error);
		}
	}

	#isCurrent(generation: number, refreshId: number): boolean {
		return (
			!this.#closed &&
			generation === this.#generation &&
			refreshId === this.#refreshId
		);
	}

	#push(event: ObserveEvent): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve(event);
		else this.#events.push(event);
	}

	#fail(error: unknown): void {
		const terminalError =
			error instanceof Error ? error : new Error(String(error));
		this.#refreshId += 1;
		this.#error = terminalError;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(terminalError);
	}
}

class MockValue {
	readonly kind:
		"null" | "boolean" | "integer" | "real" | "text" | "json" | "blob";
	readonly #value: unknown;

	constructor(kind: MockValue["kind"], value: unknown) {
		this.kind = kind;
		this.#value = value;
	}

	toJS(): unknown {
		return this.kind === "blob"
			? new Uint8Array(this.#value as Uint8Array)
			: this.#value;
	}

	asBytes(): Uint8Array<ArrayBuffer> | undefined {
		return this.kind === "blob"
			? new Uint8Array(this.#value as Uint8Array<ArrayBuffer>)
			: undefined;
	}
}

class MockRow {
	readonly #columns: string[];
	readonly #values: MockValue[];

	constructor(columns: string[], values: MockValue[]) {
		this.#columns = columns;
		this.#values = values;
	}

	get(column: string): unknown {
		return this.value(column).toJS();
	}

	value(column: string): MockValue {
		const index = this.#columns.indexOf(column);
		if (index < 0 || !this.#values[index]) {
			throw new Error(`Unknown result column: ${column}`);
		}
		return this.#values[index];
	}

	toObject(): Record<string, unknown> {
		return Object.fromEntries(
			this.#columns.map((column) => [column, this.get(column)]),
		);
	}

	toValueMap(): Record<string, MockValue> {
		return Object.fromEntries(
			this.#columns.map((column) => [column, this.value(column)]),
		);
	}
}

export class MockRemoteLixError extends Error {
	readonly code: string;
	readonly status: number | undefined;

	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = "MockRemoteLixError";
		this.code = code;
		this.status = status;
	}
}

function executeResponseToResult(payload: ExecuteResponse): ExecuteResult {
	const columns = [...payload.columns];
	return {
		columns,
		rows: payload.rows.map(
			(row) => new MockRow(columns, row.map(wireValueToMockValue)),
		),
		rowsAffected: payload.rowsAffected,
		notices: payload.notices as ExecuteResult["notices"],
	};
}

function wireValueToMockValue(value: WireValue): MockValue {
	switch (value.kind) {
		case "null":
			return new MockValue("null", null);
		case "bool":
			return new MockValue("boolean", value.value);
		case "int":
			return new MockValue("integer", value.value);
		case "float":
			return new MockValue("real", value.value);
		case "text":
			return new MockValue("text", value.value);
		case "json":
			return new MockValue("json", value.value);
		case "blob":
			return new MockValue("blob", base64ToBytes(value.base64));
		default: {
			const exhaustive: never = value;
			throw new Error(`Unknown wire value: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function sqlParamToWireValue(param: SqlParam): WireValue {
	if (isValueLike(param)) {
		const value = param.kind === "blob" ? param.asBytes() : param.toJS();
		return explicitValueToWire(param.kind, value);
	}
	if (param === null) return { kind: "null", value: null };
	if (typeof param === "boolean") return { kind: "bool", value: param };
	if (typeof param === "string") return { kind: "text", value: param };
	if (typeof param === "number") {
		if (!Number.isFinite(param)) {
			throw new TypeError("SQL number parameters must be finite");
		}
		if (Number.isInteger(param)) {
			if (!Number.isSafeInteger(param)) {
				throw new TypeError("SQL integer parameters must be safe integers");
			}
			return { kind: "int", value: param };
		}
		return { kind: "float", value: param };
	}
	if (param instanceof Uint8Array) {
		return { kind: "blob", base64: bytesToBase64(param) };
	}
	if (typeof param === "object") {
		return { kind: "json", value: param };
	}
	throw new TypeError(`Unsupported SQL parameter: ${typeof param}`);
}

function isValueLike(value: unknown): value is {
	kind: MockValue["kind"];
	toJS(): unknown;
	asBytes(): Uint8Array | undefined;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		"toJS" in value &&
		typeof value.toJS === "function" &&
		"asBytes" in value &&
		typeof value.asBytes === "function"
	);
}

function explicitValueToWire(
	kind: MockValue["kind"],
	value: unknown,
): WireValue {
	switch (kind) {
		case "null":
			return { kind: "null", value: null };
		case "boolean":
			return { kind: "bool", value: Boolean(value) };
		case "integer":
			return { kind: "int", value: Number(value) };
		case "real":
			return { kind: "float", value: Number(value) };
		case "text":
			return { kind: "text", value: String(value) };
		case "json":
			return { kind: "json", value };
		case "blob":
			if (!(value instanceof Uint8Array)) {
				throw new TypeError("Blob SQL values require Uint8Array data");
			}
			return { kind: "blob", base64: bytesToBase64(value) };
	}
}

async function* readSseFrames(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			while (true) {
				const boundary = /\r?\n\r?\n/.exec(buffer);
				if (!boundary || boundary.index === undefined) break;
				const rawFrame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const frame = parseSseFrame(rawFrame);
				if (frame) yield frame;
			}
			if (done) break;
		}
		if (buffer.trim()) {
			const frame = parseSseFrame(buffer);
			if (frame) yield frame;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseSseFrame(rawFrame: string): SseFrame | null {
	let event = "message";
	const data: string[] = [];
	for (const line of rawFrame.split(/\r?\n/)) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		let value = separator < 0 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		if (field === "data") data.push(value);
	}
	return data.length > 0 ? { event, data: data.join("\n") } : null;
}

function workspaceApiPath(workspaceId: string, endpoint: string): string {
	if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
		throw new TypeError("Workspace endpoints must be absolute paths");
	}
	return `/v1/workspaces/${encodeURIComponent(workspaceId)}${endpoint}`;
}

async function responseError(response: Response): Promise<MockRemoteLixError> {
	const body = await response.text().catch(() => "");
	let payload: unknown = body;
	try {
		payload = JSON.parse(body);
	} catch {
		// Keep the response text as the fallback message.
	}
	const message =
		errorMessage(payload) ?? `Remote Lix request failed (${response.status})`;
	const code = errorCode(payload) ?? "LIX_REMOTE_REQUEST_FAILED";
	return new MockRemoteLixError(code, message, response.status);
}

function eventError(data: string): MockRemoteLixError {
	let payload: unknown = data;
	try {
		payload = JSON.parse(data);
	} catch {
		// Keep the original event text as the fallback message.
	}
	return new MockRemoteLixError(
		errorCode(payload) ?? "LIX_OBSERVE_FAILED",
		errorMessage(payload) ?? data,
	);
}

function errorMessage(payload: unknown): string | null {
	if (typeof payload === "string" && payload.trim()) return payload.trim();
	if (!payload || typeof payload !== "object" || !("error" in payload)) {
		return null;
	}
	const error = payload.error;
	return error &&
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
		? error.message
		: null;
}

function errorCode(payload: unknown): string | null {
	if (!payload || typeof payload !== "object" || !("error" in payload)) {
		return null;
	}
	const error = payload.error;
	return error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: null;
}

function unsupportedOperation(operation: string): MockRemoteLixError {
	return new MockRemoteLixError(
		"LIX_UNSUPPORTED_REMOTE_OPERATION",
		`${operation} is not implemented by the mocked remote Lix client.`,
	);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function yieldToBrowserTask(): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
