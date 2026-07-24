import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolClient, ProtocolError } from "../lib/protocol.mjs";

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
  assert.equal(calls[2].headers["lix-session-id"], "session-capability");
  assert.equal(calls[2].method, "DELETE");
  assert.match(calls[1].body, /"sql":"SELECT 1"/);
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
