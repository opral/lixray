import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("preview protocol probe matches the selected Lix sync protocol", async () => {
  const [workflow, sync, fixture] = await Promise.all([
    readFile(new URL("../workflows/pr.yml", import.meta.url), "utf8"),
    readFile(new URL("../../vendor/lix/packages/lix/src/sync/mod.rs", import.meta.url), "utf8"),
    readFile(new URL("../../web-app/tests/e2e/sync-fixture.ts", import.meta.url), "utf8"),
  ]);
  const probeVersion = workflow.match(/sync_protocol_version=(\d+)/u)?.[1];
  const sdkVersion = sync.match(/const SYNC_PROTOCOL_VERSION: u32 = (\d+);/u)?.[1];
  assert.ok(probeVersion, "preview probe must declare its sync protocol version");
  assert.ok(sdkVersion, "selected SDK must declare its sync protocol version");
  assert.equal(probeVersion, sdkVersion, "update the preview probe with the SDK pin");
  const browserProbeVersion = fixture.match(/"Lix-Sync-Protocol-Version": "(\d+)"/u)?.[1];
  assert.ok(browserProbeVersion, "browser probe must declare its sync protocol version");
  assert.equal(browserProbeVersion, sdkVersion, "update the browser probe with the SDK pin");
});

test("preview protocol probe authenticates the current server protocol", async () => {
  const workflow = await readFile(new URL("../workflows/pr.yml", import.meta.url), "utf8");
  const library = await readFile(
    new URL("../../vendor/lix/packages/lix/src/lib.rs", import.meta.url),
    "utf8",
  );
  const probe = workflow.match(/server_protocol_version=(\d+)/u)?.[1];
  const server = library.match(/const SERVER_PROTOCOL_VERSION: u32 = (\d+);/u)?.[1];
  assert.ok(probe);
  assert.ok(server);
  assert.equal(probe, server);
  assert.match(workflow, /Lix-Server-Protocol-Version: \$server_protocol_version/u);
});
