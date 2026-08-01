import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolClient,
  ProtocolError,
  readServerStorageIdentity,
  ServerIdentityError,
} from "../lib/protocol.mjs";

test("reads the storage identity attested by server health", async () => {
  let request;
  const identity = await readServerStorageIdentity({
    baseUrl: "http://example.test/",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return Response.json({
        ok: true,
        service: "lix-server",
        storageBackend: "slatedb",
        storageLayout: "lix-slatedb-lz4-v1",
      });
    },
  });

  assert.deepEqual(identity, {
    storageBackend: "slatedb",
    storageLayout: "lix-slatedb-lz4-v1",
  });
  assert.equal(request.url, "http://example.test/healthz");
  assert.equal(request.method, "GET");
});

test("rejects a health response without a storage layout attestation", async () => {
  await assert.rejects(
    readServerStorageIdentity({
      baseUrl: "http://example.test",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          service: "lix-server",
          storageBackend: "slatedb",
        }),
    }),
    (error) =>
      error instanceof ServerIdentityError &&
      /invalid storageLayout attestation/.test(error.message),
  );
});

test("handshake establishes a session used by execute and close", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "GET") {
      return Response.json({
        protocolVersion: 1,
        activeBranchId: "main",
        sessionId: "session-capability",
        capabilities: { requestBlobSplice: true },
      });
    }
    if (options.method === "POST") {
      return Response.json({
        columns: [],
        rows: [],
        rowsAffected: 0,
        notices: [],
      });
    }
    return new Response(null, { status: 204 });
  };
  const client = new ProtocolClient({
    baseUrl: "http://example.test/",
    workspaceId: "workspace with spaces",
    internalToken: "internal-token",
    fetchImpl,
  });

  const handshake = await client.open();
  assert.equal(handshake.protocolVersion, 1);
  assert.equal(handshake.sessionId, undefined);
  assert.equal(client.hasSession, true);
  await client.execute("SELECT 1");
  await client.close();
  assert.equal(client.hasSession, false);

  assert.equal(
    calls[0].url,
    "http://example.test/lixes/workspace%20with%20spaces/lix/v1/",
  );
  assert.equal(calls[0].headers["lix-session-id"], undefined);
  assert.equal(calls[0].headers.authorization, "Bearer internal-token");
  assert.equal(calls[1].headers["lix-session-id"], "session-capability");
  assert.match(
    calls[1].headers["idempotency-key"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert.equal(calls[2].headers["lix-session-id"], "session-capability");
  assert.equal(calls[2].method, "DELETE");
  assert.match(calls[1].body, /"sql":"SELECT 1"/);
});

test("SQL write requests preserve their caller-provided idempotency keys", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-idempotency" });
      }
      return Response.json({
        columns: [],
        rows: [],
        rowsAffected: 1,
        notices: [],
      });
    },
  });

  await client.open();
  await client.execute("UPDATE lix_file SET path = path", [], {
    idempotencyKey: "perf-execute-key",
  });
  await client.executeBatch(
    [{ sql: "UPDATE lix_file SET path = path", params: [] }],
    { idempotencyKey: "perf-batch-key" },
  );
  await client.executeFileData("/payload.bin", Buffer.from([1]), {
    idempotencyKey: "perf-file-key",
  });

  assert.deepEqual(
    calls.slice(1).map((call) => call.headers["idempotency-key"]),
    ["perf-execute-key", "perf-batch-key", "perf-file-key"],
  );
});

test("close clears the session even when the request fails", async () => {
  let requests = 0;
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-capability" });
      }
      return new Response("gone", { status: 410 });
    },
  });

  await client.open();
  await assert.rejects(client.close(), ProtocolError);
  assert.equal(client.hasSession, false);
  assert.equal(requests, 2);
});

test("execute requires an established session", async () => {
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  assert.throws(() => client.execute("SELECT 1"), /session is not open/);
});

test("upsertFileData sends an authenticated raw octet-stream request", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    internalToken: "internal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-file-upsert" });
      }
      return Response.json({
        columns: [],
        rows: [],
        rowsAffected: 1,
        notices: [],
      });
    },
  });

  await client.open();
  const payload = Buffer.from([0, 1, 2, 255]);
  const result = await client.upsertFileData("/nested/payload.bin", payload);

  assert.equal(result.value.rowsAffected, 1);
  assert.equal(result.requestBytes, payload.byteLength);
  assert.equal(
    calls[1].url,
    "http://example.test/lixes/workspace/lix/v1/file/upsert?path=%2Fnested%2Fpayload.bin",
  );
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.authorization, "Bearer internal-token");
  assert.equal(calls[1].headers["lix-session-id"], "session-file-upsert");
  assert.equal(calls[1].headers["content-type"], "application/octet-stream");
  assert.deepEqual(calls[1].body, payload);
});

test("upsertFileData keeps resumable media parts on the same file abstraction", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    internalToken: "internal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-file-part" });
      }
      return new Response(JSON.stringify({ rowsAffected: 0, columns: [], rows: [] }), {
        status: 308,
        headers: { "content-type": "application/json", range: "bytes=0-3" },
      });
    },
  });

  await client.open();
  const result = await client.upsertFileData(
    "/proxy.mov",
    Buffer.from([1, 2, 3, 4]),
    { uploadId: "proxy-1", start: 0, totalSize: 8 },
  );

  assert.equal(result.value.finalized, false);
  assert.equal(result.value.nextOffset, 4);
  assert.equal(calls[1].headers["lix-upload-id"], "proxy-1");
  assert.equal(calls[1].headers["content-range"], "bytes 0-3/8");
});

test("upsertFileDataBatch frames raw entries after its advertised capability", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    internalToken: "internal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({
          sessionId: "session-file-upsert-batch",
          capabilities: { binaryFileUpsertBatch: true },
        });
      }
      const entries = decodeFileUpsertBatch(options.body);
      return Response.json({
        columns: [],
        rows: [],
        rowsAffected: entries.length,
        notices: [],
      });
    },
  });

  await client.open();
  const entries = [
    { path: "/nested/\u00e5.json", data: Buffer.from([0, 1, 2, 255]) },
    { path: "/nested/data.csv", data: Buffer.from("a,b\n1,2\n") },
  ];
  const result = await client.upsertFileDataBatch(entries);

  assert.equal(result.value.rowsAffected, 2);
  assert.equal(
    result.requestBytes,
    4 +
      entries.reduce(
        (total, { path, data }) =>
          total + 8 + Buffer.byteLength(path) + data.byteLength,
        0,
      ),
  );
  assert.equal(
    calls[1].url,
    "http://example.test/lixes/workspace/lix/v1/file/upsert-batch",
  );
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.authorization, "Bearer internal-token");
  assert.equal(calls[1].headers["lix-session-id"], "session-file-upsert-batch");
  assert.equal(calls[1].headers["content-type"], "application/octet-stream");
  assert.deepEqual(decodeFileUpsertBatch(calls[1].body), entries);
});

test("upsertFileDataBatch rejects more than 1,024 entries to preserve atomicity", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (_url, options) => {
      calls.push(options);
      if (options.method === "GET") {
        return Response.json({
          sessionId: "session-file-upsert-batch-limit",
          capabilities: { binaryFileUpsertBatch: true },
        });
      }
      throw new Error("an oversized batch must not issue an upsert request");
    },
  });
  await client.open();

  await assert.rejects(
    client.upsertFileDataBatch(
      Array.from({ length: 1_025 }, (_, index) => ({
        path: `/files/${index}`,
        data: Buffer.from([index % 256]),
      })),
    ),
    /at most 1024 entries so one call remains atomic/,
  );
  assert.equal(calls.length, 1);
});

test("readFileData sends an authenticated raw GET and preserves binary bytes", async () => {
  const calls = [];
  const payload = Buffer.from([0, 1, 2, 255]);
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    internalToken: "internal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1) {
        return Response.json({
          sessionId: "session-file-read",
          capabilities: { binaryFileRead: true },
        });
      }
      return new Response(payload, {
        headers: {
          "content-type": "application/octet-stream",
          "lix-file-found": "true",
        },
      });
    },
  });

  await client.open();
  const result = await client.readFileData("/nested/payload.bin");

  assert.equal(result.value.found, true);
  assert.deepEqual(result.value.data, payload);
  assert.equal(result.value.contentRange, null);
  assert.equal(result.requestBytes, 0);
  assert.equal(result.responseBytes, payload.byteLength);
  assert.equal(
    calls[1].url,
    "http://example.test/lixes/workspace/lix/v1/file?path=%2Fnested%2Fpayload.bin",
  );
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].headers.authorization, "Bearer internal-token");
  assert.equal(calls[1].headers["lix-session-id"], "session-file-read");
  assert.equal(calls[1].headers["content-type"], undefined);
  assert.equal(calls[1].body, undefined);
});

test("readFileData sends one bounded byte range", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1) {
        return Response.json({
          sessionId: "session-file-range",
          capabilities: { binaryFileRead: true },
        });
      }
      return new Response(Buffer.from([2, 3, 4]), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": "bytes 2-4/10",
          "lix-file-found": "true",
        },
      });
    },
  });

  await client.open();
  const result = await client.readFileData("/clip.mov", {
    start: 2,
    endExclusive: 5,
  });

  assert.equal(calls[1].headers.range, "bytes=2-4");
  assert.deepEqual(result.value.data, Buffer.from([2, 3, 4]));
  assert.equal(result.value.contentRange, "bytes 2-4/10");
});

test("readFileData validates its session, capability, and path before dispatch", async () => {
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  await assert.rejects(
    client.readFileData("/payload.bin"),
    /session is not open/,
  );
  client.sessionId = "session-file-read";
  await assert.rejects(
    client.readFileData("/payload.bin"),
    /does not advertise the binaryFileRead capability/,
  );
  client.capabilities = { binaryFileRead: true };
  await assert.rejects(
    client.readFileData(""),
    /path must be a non-empty string/,
  );
});

test("readFileData distinguishes present empty files from missing files", async () => {
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (_url, options) => {
      if (options.method === "GET" && !options.headers["lix-session-id"]) {
        return Response.json({
          sessionId: "session-file-empty",
          capabilities: { binaryFileRead: true },
        });
      }
      const path = new URL(_url).searchParams.get("path");
      if (path === "/empty.bin") {
        return new Response(Buffer.alloc(0), {
          headers: {
            "content-type": "application/octet-stream",
            "lix-file-found": "true",
          },
        });
      }
      if (path === "/missing.bin") {
        return new Response(Buffer.alloc(0), {
          headers: {
            "content-type": "application/octet-stream",
            "lix-file-found": "false",
          },
        });
      }
      return new Response(Buffer.from([1]), {
        headers: {
          "content-type": "application/octet-stream",
          "lix-file-found": "false",
        },
      });
    },
  });

  await client.open();
  const empty = await client.readFileData("/empty.bin");
  const missing = await client.readFileData("/missing.bin");
  assert.deepEqual(empty.value, {
    found: true,
    data: Buffer.alloc(0),
    contentRange: null,
  });
  assert.deepEqual(missing.value, {
    found: false,
    data: Buffer.alloc(0),
    contentRange: null,
  });
  await assert.rejects(
    client.readFileData("/invalid-missing.bin"),
    /returned bytes for a missing file/,
  );
});

test("readFileDataJson decodes the matched SQL/base64 response before timing stops", async () => {
  const calls = [];
  const payload = Buffer.from([0, 1, 2, 255]);
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    internalToken: "internal-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-file-json" });
      }
      return Response.json({
        columns: [],
        rows: [
          [
            { kind: "text", value: "/nested/payload.bin" },
            { kind: "blob", base64: payload.toString("base64") },
          ],
        ],
        rowsAffected: 0,
        notices: [],
      });
    },
  });

  await client.open();
  const result = await client.readFileDataJson("/nested/payload.bin");

  assert.deepEqual(result.value.data, payload);
  assert.equal(result.value.response.rows.length, 1);
  const body = JSON.parse(calls[1].body);
  assert.equal(body.sql, "SELECT path, data FROM lix_file WHERE path = $1");
  assert.deepEqual(body.params, [
    { kind: "text", value: "/nested/payload.bin" },
  ]);
  assert.equal(result.requestBytes, Buffer.byteLength(calls[1].body));
  assert.equal(calls[1].headers["content-type"], "application/json");
});

test("executeFileData keeps JSON/base64 work inside the timed protocol request", async () => {
  const calls = [];
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        return Response.json({ sessionId: "session-file-json" });
      }
      return Response.json({
        columns: [],
        rows: [],
        rowsAffected: 1,
        notices: [],
      });
    },
  });

  await client.open();
  const payload = Buffer.from([0, 1, 2, 255]);
  const result = await client.executeFileData("/payload.bin", payload, {
    shape: "upsert",
  });

  const body = JSON.parse(calls[1].body);
  assert.match(body.sql, /ON CONFLICT \(path\) DO UPDATE/);
  assert.deepEqual(body.params, [
    { kind: "text", value: "/payload.bin" },
    { kind: "blob", base64: payload.toString("base64") },
  ]);
  assert.equal(result.requestBytes, Buffer.byteLength(calls[1].body));
  assert.equal(calls[1].headers["content-type"], "application/json");
});

test("upsertFileData validates its local call shape", () => {
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  assert.throws(
    () => client.upsertFileData("/payload.bin", Buffer.alloc(0)),
    /session is not open/,
  );
  client.sessionId = "session-file-upsert";
  assert.throws(
    () => client.upsertFileData("", Buffer.alloc(0)),
    /non-empty string/,
  );
  assert.throws(
    () => client.upsertFileData("/payload.bin", new Uint8Array([1])),
    /must be a Buffer/,
  );
});

test("upsertFileDataBatch validates capability and every entry before requests", async () => {
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  client.sessionId = "session-file-upsert-batch";
  await assert.rejects(
    client.upsertFileDataBatch([{ path: "/a", data: Buffer.alloc(0) }]),
    /does not advertise the binaryFileUpsertBatch capability/,
  );
  client.capabilities = { binaryFileUpsertBatch: true };
  await assert.rejects(
    client.upsertFileDataBatch([]),
    /must be a non-empty array/,
  );
  await assert.rejects(
    client.upsertFileDataBatch([
      { path: "/a", data: Buffer.alloc(0) },
      { path: "/a", data: Buffer.alloc(0) },
    ]),
    /duplicates \/a/,
  );
  await assert.rejects(
    client.upsertFileDataBatch([
      { path: "/a", data: Buffer.alloc(0) },
      { path: "/b", data: new Uint8Array([1]) },
    ]),
    /data must be a Buffer/,
  );
});

test("branch methods use the authenticated protocol endpoints", async () => {
  const calls = [];
  let getCalls = 0;
  const client = new ProtocolClient({
    baseUrl: "http://example.test",
    workspaceId: "workspace",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET") {
        getCalls += 1;
        return Response.json({
          sessionId: "session-branch",
          activeBranchId: getCalls === 1 ? "main" : "perf-branch-0000",
        });
      }
      if (url.endsWith("/branch/create")) {
        return Response.json({
          id: "perf-branch-0000",
          name: "Perf branch 0000",
          hidden: false,
          commitId: "commit-123",
        });
      }
      if (url.endsWith("/branch/switch")) {
        return Response.json({ branchId: "perf-branch-0000" });
      }
      throw new Error(`unexpected request ${options.method} ${url}`);
    },
  });

  await client.open();
  const created = await client.createBranch({
    id: "perf-branch-0000",
    name: "Perf branch 0000",
  });
  const switched = await client.switchBranch("perf-branch-0000");
  const session = await client.sessionInfo();

  assert.equal(created.value.id, "perf-branch-0000");
  assert.equal(created.value.commitId, "commit-123");
  assert.equal(switched.value.branchId, "perf-branch-0000");
  assert.equal(session.value.activeBranchId, "perf-branch-0000");
  assert.equal(calls[1].headers["lix-session-id"], "session-branch");
  assert.deepEqual(JSON.parse(calls[1].body), {
    id: "perf-branch-0000",
    name: "Perf branch 0000",
  });
  assert.deepEqual(JSON.parse(calls[2].body), {
    branchId: "perf-branch-0000",
  });
  assert.equal(calls[3].headers["lix-session-id"], "session-branch");
});

function decodeFileUpsertBatch(frame) {
  const entries = [];
  const count = frame.readUInt32BE(0);
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    const pathLength = frame.readUInt32BE(offset);
    offset += 4;
    const dataLength = frame.readUInt32BE(offset);
    offset += 4;
    const path = frame.toString("utf8", offset, offset + pathLength);
    offset += pathLength;
    const data = Buffer.from(frame.subarray(offset, offset + dataLength));
    offset += dataLength;
    entries.push({ path, data });
  }
  assert.equal(offset, frame.byteLength);
  return entries;
}
