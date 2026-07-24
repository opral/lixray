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

  const response = await fetchImpl(
    `${baseUrl.replace(/\/+$/, "")}/healthz`,
    { method: "GET" },
  );
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
    storageBackend: storageIdentityField(value.storageBackend, "storageBackend"),
    storageLayout: storageIdentityField(value.storageLayout, "storageLayout"),
  };
}

function storageIdentityField(value, name) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)
  ) {
    throw new ServerIdentityError(
      `GET /healthz returned an invalid ${name} attestation`,
    );
  }
  return value;
}

export class ProtocolClient {
  constructor({
    baseUrl,
    workspaceId,
    internalToken,
    fetchImpl = globalThis.fetch,
  }) {
    if (typeof fetchImpl !== "function") {
      throw new Error("a fetch implementation is required");
    }
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/lixes/${encodeURIComponent(
      workspaceId,
    )}/lix/v1`;
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

  execute(sql, params = []) {
    this.requireSession();
    return this.request("execute", "POST", { sql, params });
  }

  executeBatch(statements) {
    this.requireSession();
    return this.request("execute-batch", "POST", { statements });
  }

  executeFileData(path, data, { shape = "update" } = {}) {
    this.requireSession();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("executeFileData path must be a non-empty string");
    }
    if (!Buffer.isBuffer(data)) {
      throw new TypeError("executeFileData data must be a Buffer");
    }
    if (!["insert", "update", "upsert"].includes(shape)) {
      throw new TypeError("executeFileData shape must be insert, update, or upsert");
    }
    return this.requestLazyJson("execute", "POST", () => {
      const blob = { kind: "blob", base64: data.toString("base64") };
      const text = { kind: "text", value: path };
      if (shape === "insert") {
        return {
          sql: "INSERT INTO lix_file (path, data) VALUES ($1, $2)",
          params: [text, blob],
        };
      }
      if (shape === "upsert") {
        return {
          sql:
            "INSERT INTO lix_file (path, data) VALUES ($1, $2) " +
            "ON CONFLICT (path) DO UPDATE SET data = excluded.data",
          params: [text, blob],
        };
      }
      return {
        sql: "UPDATE lix_file SET data = $1 WHERE path = $2",
        params: [blob, text],
      };
    });
  }

  upsertFileData(path, data) {
    this.requireSession();
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("upsertFileData path must be a non-empty string");
    }
    if (!Buffer.isBuffer(data)) {
      throw new TypeError("upsertFileData data must be a Buffer");
    }
    return this.requestBinary(
      `file/upsert?path=${encodeURIComponent(path)}`,
      "POST",
      data,
    );
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

  async request(path, method, body) {
    const started = performance.now();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return this.requestEncoded(
      path,
      method,
      encoded,
      encoded === undefined ? undefined : "application/json",
      started,
    );
  }

  async requestBinary(path, method, body) {
    const started = performance.now();
    return this.requestEncoded(
      path,
      method,
      body,
      "application/octet-stream",
      started,
    );
  }

  async requestLazyJson(path, method, makeBody) {
    const started = performance.now();
    const encoded = JSON.stringify(makeBody());
    return this.requestEncoded(
      path,
      method,
      encoded,
      "application/json",
      started,
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

  async requestEncoded(path, method, body, contentType, started) {
    const headers = {};
    if (contentType !== undefined) {
      headers["content-type"] = contentType;
    }
    if (this.internalToken) {
      headers.authorization = `Bearer ${this.internalToken}`;
    }
    if (this.sessionId) {
      headers["lix-session-id"] = this.sessionId;
    }

    const url = path ? `${this.endpoint}/${path}` : `${this.endpoint}/`;
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
    });
    const text = await response.text();
    if (!response.ok) {
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
    };
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
      throw new TypeError(`upsertFileDataBatch entry ${index} duplicates ${path}`);
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
      throw new RangeError("upsertFileDataBatch frame exceeds safe allocation size");
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
