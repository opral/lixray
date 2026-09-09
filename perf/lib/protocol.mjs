import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const MAX_BINARY_FILE_UPSERT_BATCH_ENTRIES = 1_024;
const MAX_U32 = 0xffff_ffff;

export class ProtocolError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} failed with HTTP ${status}: ${body}`);
    this.name = "ProtocolError";
    this.status = status;
  }
}

export class ServerIdentityError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "ServerIdentityError";
    this.retryable = retryable;
  }
}

export async function readServerStorageIdentity({
  baseUrl,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("a fetch implementation is required");
  }

  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/healthz`, {
    method: "GET",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new ServerIdentityError(
      `GET /healthz failed with HTTP ${response.status}: ${body}`,
      { retryable: response.status >= 500 },
    );
  }

  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new ServerIdentityError(
      `GET /healthz returned invalid JSON: ${error.message}`,
    );
  }
  if (value?.ok !== true || value.service !== "lix-server") {
    throw new ServerIdentityError(
      "GET /healthz did not return the lix-server health response",
    );
  }

  return {
    storageBackend: storageIdentityField(
      value.storageBackend,
      "storageBackend",
    ),
    storageLayout: storageIdentityField(value.storageLayout, "storageLayout"),
  };
}

function storageIdentityField(value, name) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw new ServerIdentityError(
      `GET /healthz returned an invalid ${name} attestation`,
    );
  }
  return value;
}

export class ProtocolClient {
  constructor({
    baseUrl,
    repositoryId,
    internalToken,
    fetchImpl = globalThis.fetch,
  }) {
    if (typeof fetchImpl !== "function") {
      throw new Error("a fetch implementation is required");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        repositoryId,
      )
    ) {
      throw new Error("repositoryId must be a canonical UUID");
    }
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/lix/v1/${repositoryId}`;
    this.internalToken = internalToken;
    this.fetchImpl = fetchImpl;
    this.sessionId = undefined;
    this.capabilities = undefined;
  }

  get hasSession() {
    return this.sessionId !== undefined;
  }

  async open() {
    if (this.hasSession) {
      throw new Error("protocol session is already open");
    }
    const sample = await this.request("", "GET");
    const sessionId = sample.value?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("handshake response did not contain a sessionId");
    }
    this.sessionId = sessionId;
    this.capabilities = sample.value.capabilities;
    return {
      elapsedMs: sample.elapsedMs,
      protocolVersion: sample.value.protocolVersion,
      activeBranchId: sample.value.activeBranchId,
      capabilities: sample.value.capabilities,
    };
  }

  execute(sql, params = [], { idempotencyKey } = {}) {
    this.requireSession();
    return this.request("execute", "POST", { sql, params }, {
      idempotencyKey: idempotencyKeyFor(idempotencyKey),
    });
  }

  executeBatch(statements, { idempotencyKey } = {}) {
    this.requireSession();
    return this.request("execute-batch", "POST", { statements }, {
      idempotencyKey: idempotencyKeyFor(idempotencyKey),
    });
  }

  executeFileData(path, data, { shape = "update", idempotencyKey } = {}) {
    this.requireSession();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("executeFileData path must be a non-empty string");
    }
    if (!Buffer.isBuffer(data)) {
      throw new TypeError("executeFileData data must be a Buffer");
    }
    if (!["insert", "update", "upsert"].includes(shape)) {
      throw new TypeError(
        "executeFileData shape must be insert, update, or upsert",
      );
    }
    return this.requestLazyJson("execute", "POST", () => {
      const blob = { kind: "blob", base64: data.toString("base64") };
      const text = { kind: "text", value: path };
      if (shape === "insert") {
        return {
          sql: "INSERT INTO lix_file (path, content) VALUES ($1, $2)",
          params: [text, blob],
        };
      }
      if (shape === "upsert") {
        return {
          sql:
            "INSERT INTO lix_file (path, content) VALUES ($1, $2) " +
            "ON CONFLICT (path) DO UPDATE SET content = excluded.content",
          params: [text, blob],
        };
      }
      return {
        sql: "UPDATE lix_file SET content = $1 WHERE path = $2",
        params: [blob, text],
      };
    }, { idempotencyKey: idempotencyKeyFor(idempotencyKey) });
  }

  upsertFileData(path, data, upload = undefined) {
    this.requireSession();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("upsertFileData path must be a non-empty string");
    }
    if (!Buffer.isBuffer(data)) {
      throw new TypeError("upsertFileData data must be a Buffer");
    }
    if (upload === undefined) {
      return this.requestBinary(
        `file/upsert?path=${encodeURIComponent(path)}`,
        "POST",
        data,
      );
    }
    const { uploadId, start, totalSize } = upload;
    if (typeof uploadId !== "string" || uploadId.length === 0) {
      throw new TypeError("upsertFileData uploadId must be a non-empty string");
    }
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new TypeError("upsertFileData start must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new TypeError("upsertFileData totalSize must be a positive safe integer");
    }
    const end = start + data.byteLength - 1;
    if (data.byteLength === 0 || end >= totalSize) {
      throw new RangeError("upsertFileData part must fit inside totalSize");
    }
    return this.requestBinary(
      `file/upsert?path=${encodeURIComponent(path)}`,
      "POST",
      data,
      {
        additionalHeaders: {
          "lix-upload-id": uploadId,
          "content-range": `bytes ${start}-${end}/${totalSize}`,
        },
        acceptedStatuses: [308],
      },
    ).then((result) => {
      const acknowledged = result.headers.get("range");
      const nextOffset = acknowledged
        ? Number.parseInt(
            acknowledged.slice(acknowledged.lastIndexOf("-") + 1),
            10,
          ) + 1
        : totalSize;
      return {
        ...result,
        value: {
          ...result.value,
          finalized: result.status !== 308,
          nextOffset,
        },
      };
    });
  }

  async upsertFileDataBatch(entries) {
    // Match a caller's sequential single-upsert control: its logical timer
    // includes each local validation before transport begins.
    const started = performance.now();
    this.requireSession();
    this.requireBinaryFileUpsertBatchCapability();
    const normalizedEntries = normalizeFileUpsertBatchEntries(entries);
    if (normalizedEntries.length > MAX_BINARY_FILE_UPSERT_BATCH_ENTRIES) {
      throw new RangeError(
        `upsertFileDataBatch accepts at most ${MAX_BINARY_FILE_UPSERT_BATCH_ENTRIES} entries so one call remains atomic`,
      );
    }
    const response = await this.requestLazyBinary(
      "file/upsert-batch",
      "POST",
      () => encodeFileUpsertBatch(normalizedEntries),
    );
    const elapsedMs = performance.now() - started;

    return {
      value: response.value,
      // Include batch frame construction and transport in the logical timer.
      // Byte accounting remains outside the timer, like requestEncoded.
      elapsedMs,
      requestBytes: response.requestBytes,
      responseBytes: response.responseBytes,
    };
  }

  async readFileData(path, range = undefined) {
    // Match execute(): invariant validation is not useful transport work, but
    // URI construction, request dispatch, and body materialization are.
    this.requireSession();
    this.requireBinaryFileReadCapability();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("readFileData path must be a non-empty string");
    }
    let requestHeaders;
    if (range !== undefined) {
      if (
        !Number.isSafeInteger(range?.start) ||
        !Number.isSafeInteger(range?.endExclusive) ||
        range.start < 0 ||
        range.start >= range.endExclusive
      ) {
        throw new RangeError(
          "readFileData range must contain non-negative safe-integer start and larger endExclusive",
        );
      }
      requestHeaders = {
        range: `bytes=${range.start}-${range.endExclusive - 1}`,
      };
    }
    const started = performance.now();
    return this.requestRawFile(
      `file?path=${encodeURIComponent(path)}`,
      "GET",
      started,
      requestHeaders,
    );
  }

  async readFileDataJson(path) {
    // This is the matched SQL control for `readFileData`: both logical timers
    // include request construction, body consumption, and decoding usable
    // bytes rather than putting Base64 materialization in a later assertion.
    this.requireSession();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("readFileDataJson path must be a non-empty string");
    }
    const started = performance.now();
    const body = JSON.stringify({
      sql: "SELECT path, content FROM lix_file WHERE path = $1",
      params: [{ kind: "text", value: path }],
    });
    const response = await this.fetchImpl(`${this.endpoint}/execute`, {
      method: "POST",
      headers: this.requestHeaders("application/json"),
      body,
    });
    const text = await response.text();
    let value = null;
    let parseError;
    if (text.length > 0) {
      try {
        value = JSON.parse(text);
      } catch (error) {
        parseError = error;
      }
    }
    const base64 = value?.rows?.[0]?.[1]?.base64;
    const data =
      typeof base64 === "string" ? Buffer.from(base64, "base64") : null;
    const elapsedMs = performance.now() - started;

    // Keep protocol-envelope validation outside the timed usable-byte path.
    // The benchmark's semantic assertion verifies the row path and payload.
    if (!response.ok) {
      throw new ProtocolError("POST", "execute", response.status, text);
    }
    if (parseError) {
      throw new Error(
        `POST execute returned invalid JSON: ${parseError.message}`,
      );
    }
    if (data === null) {
      throw new Error(`POST execute did not return binary data for ${path}`);
    }
    return {
      value: {
        response: value,
        data,
      },
      elapsedMs,
      requestBytes: Buffer.byteLength(body),
      responseBytes: Buffer.byteLength(text),
    };
  }

  createBranch({ id, name, fromCommitId } = {}) {
    this.requireSession();
    return this.request("branch/create", "POST", { id, name, fromCommitId });
  }

  switchBranch(branchId) {
    this.requireSession();
    return this.request("branch/switch", "POST", { branchId });
  }

  sessionInfo() {
    this.requireSession();
    return this.request("", "GET");
  }

  async close() {
    if (!this.hasSession) {
      return undefined;
    }
    try {
      return await this.request("session", "DELETE");
    } finally {
      this.sessionId = undefined;
      this.capabilities = undefined;
    }
  }

  async request(path, method, body, { idempotencyKey } = {}) {
    const started = performance.now();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return this.requestEncoded(
      path,
      method,
      encoded,
      encoded === undefined ? undefined : "application/json",
      started,
      idempotencyKey,
    );
  }

  async requestBinary(path, method, body, options = {}) {
    const started = performance.now();
    return this.requestEncoded(
      path,
      method,
      body,
      "application/octet-stream",
      started,
      undefined,
      options.additionalHeaders,
      options.acceptedStatuses,
    );
  }

  async requestLazyJson(path, method, makeBody, { idempotencyKey } = {}) {
    const started = performance.now();
    const encoded = JSON.stringify(makeBody());
    return this.requestEncoded(
      path,
      method,
      encoded,
      "application/json",
      started,
      idempotencyKey,
    );
  }

  async requestLazyBinary(path, method, makeBody) {
    const started = performance.now();
    const encoded = makeBody();
    return this.requestEncoded(
      path,
      method,
      encoded,
      "application/octet-stream",
      started,
    );
  }

  async requestRawFile(path, method, started, additionalHeaders = undefined) {
    const response = await this.fetchImpl(`${this.endpoint}/${path}`, {
      method,
      headers: { ...this.requestHeaders(), ...additionalHeaders },
    });
    const data = Buffer.from(await response.arrayBuffer());
    const elapsedMs = performance.now() - started;

    // Response-envelope validation is deliberately after the timer. This
    // keeps the binary arm aligned with the JSON control, whose row/path
    // checks are benchmark assertions rather than measured work.
    if (!response.ok) {
      throw new ProtocolError(
        method,
        path,
        response.status,
        data.toString("utf8"),
      );
    }
    if (response.headers.get("content-type") !== "application/octet-stream") {
      throw new Error(`${method} ${path} returned an unexpected content type`);
    }
    const foundHeader = response.headers.get("lix-file-found");
    if (foundHeader !== "true" && foundHeader !== "false") {
      throw new Error(
        `${method} ${path} returned an invalid Lix-File-Found header`,
      );
    }
    const found = foundHeader === "true";
    if (!found && data.byteLength !== 0) {
      throw new Error(`${method} ${path} returned bytes for a missing file`);
    }
    const contentRange = response.headers.get("content-range");
    return {
      value: { found, data, contentRange },
      elapsedMs,
      requestBytes: 0,
      responseBytes: data.byteLength,
    };
  }

  async requestEncoded(
    path,
    method,
    body,
    contentType,
    started,
    idempotencyKey,
    additionalHeaders = undefined,
    acceptedStatuses = undefined,
  ) {
    const url = path ? `${this.endpoint}/${path}` : `${this.endpoint}/`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        ...this.requestHeaders(contentType, idempotencyKey),
        ...additionalHeaders,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok && !acceptedStatuses?.includes(response.status)) {
      throw new ProtocolError(method, path || "/", response.status, text);
    }
    let value = null;
    if (text.length > 0) {
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${method} ${path || "/"} returned invalid JSON: ${error.message}`,
        );
      }
    }
    const elapsedMs = performance.now() - started;
    return {
      value,
      elapsedMs,
      // Account for encoded bytes only after stopping the timer. JSON
      // serialization belongs in the measured path; byte bookkeeping does
      // not, especially for multi-megabyte controls.
      requestBytes: requestBodyBytes(body),
      responseBytes: Buffer.byteLength(text),
      status: response.status,
      headers: response.headers,
    };
  }

  requestHeaders(contentType, idempotencyKey) {
    const headers = { "lix-server-protocol-version": "7" };
    if (contentType !== undefined) {
      headers["content-type"] = contentType;
    }
    if (this.internalToken) {
      headers.authorization = `Bearer ${this.internalToken}`;
    }
    if (this.sessionId) {
      headers["lix-session-id"] = this.sessionId;
    }
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    return headers;
  }

  requireSession() {
    if (!this.hasSession) {
      throw new Error("protocol session is not open");
    }
  }

  requireBinaryFileUpsertBatchCapability() {
    if (this.capabilities?.binaryFileUpsertBatch !== true) {
      throw new Error(
        "server does not advertise the binaryFileUpsertBatch capability",
      );
    }
  }

  requireBinaryFileReadCapability() {
    if (this.capabilities?.binaryFileRead !== true) {
      throw new Error(
        "server does not advertise the binaryFileRead capability",
      );
    }
  }
}

function normalizeFileUpsertBatchEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError(
      "upsertFileDataBatch entries must be a non-empty array",
    );
  }

  const paths = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(
        `upsertFileDataBatch entry ${index} must be an object with path and data`,
      );
    }
    const { path, data } = entry;
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError(
        `upsertFileDataBatch entry ${index} path must be a non-empty string`,
      );
    }
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(
        `upsertFileDataBatch entry ${index} data must be a Buffer`,
      );
    }
    if (Buffer.byteLength(path) > MAX_U32) {
      throw new RangeError(
        `upsertFileDataBatch entry ${index} path exceeds the u32 wire limit`,
      );
    }
    if (data.byteLength > MAX_U32) {
      throw new RangeError(
        `upsertFileDataBatch entry ${index} data exceeds the u32 wire limit`,
      );
    }
    if (paths.has(path)) {
      throw new TypeError(
        `upsertFileDataBatch entry ${index} duplicates ${path}`,
      );
    }
    paths.add(path);
    return { path, data };
  });
}

function encodeFileUpsertBatch(entries) {
  let byteLength = 4;
  for (const { path, data } of entries) {
    byteLength += 8 + Buffer.byteLength(path) + data.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw new RangeError(
        "upsertFileDataBatch frame exceeds safe allocation size",
      );
    }
  }

  const frame = Buffer.allocUnsafe(byteLength);
  frame.writeUInt32BE(entries.length, 0);
  let offset = 4;
  for (const { path, data } of entries) {
    const pathLength = Buffer.byteLength(path);
    frame.writeUInt32BE(pathLength, offset);
    offset += 4;
    frame.writeUInt32BE(data.byteLength, offset);
    offset += 4;
    frame.write(path, offset, pathLength, "utf8");
    offset += pathLength;
    data.copy(frame, offset);
    offset += data.byteLength;
  }
  return frame;
}

function requestBodyBytes(body) {
  if (body === undefined) {
    return 0;
  }
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }
  return body.byteLength;
}

function idempotencyKeyFor(provided) {
  if (provided !== undefined && typeof provided !== "string") {
    throw new TypeError("idempotencyKey must be a string");
  }
  const key = provided ?? randomUUID();
  if (
    key.length === 0 ||
    key.length > 255 ||
    ![...key].every(
      (character) =>
        character.length === 1 &&
        character.charCodeAt(0) >= 0x21 &&
        character.charCodeAt(0) <= 0x7e,
    )
  ) {
    throw new TypeError(
      "idempotencyKey must contain 1 to 255 visible ASCII characters",
    );
  }
  return key;
}
