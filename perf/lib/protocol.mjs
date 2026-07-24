import { performance } from "node:perf_hooks";

export class ProtocolError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} failed with HTTP ${status}: ${body}`);
    this.name = "ProtocolError";
    this.status = status;
  }
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
    }
  }

  async request(path, method, body) {
    const started = performance.now();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (encoded !== undefined) {
      headers["content-type"] = "application/json";
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
      body: encoded,
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
      requestBytes: encoded === undefined ? 0 : Buffer.byteLength(encoded),
      responseBytes: Buffer.byteLength(text),
    };
  }

  requireSession() {
    if (!this.hasSession) {
      throw new Error("protocol session is not open");
    }
  }
}
