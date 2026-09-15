import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getCompatibility } from "../../vendor/lix/scripts/compatibility.mjs";

test("deployment probes use the pinned Lix compatibility contract before SDK build", async () => {
  const [workflow, fixture] = await Promise.all([
    readFile(new URL("../workflows/pr.yml", import.meta.url), "utf8"),
    readFile(new URL("../../web-app/tests/e2e/sync-fixture.ts", import.meta.url), "utf8"),
  ]);
  const metadata = JSON.parse(execFileSync(process.execPath, [
    new URL("../../vendor/lix/scripts/compatibility.mjs", import.meta.url).pathname,
  ], { encoding: "utf8" }));
  assert.deepEqual(metadata, getCompatibility());
  assert.match(workflow, /node vendor\/lix\/scripts\/compatibility\.mjs/u);
  assert.match(workflow, /\.syncProtocolVersion/u);
  assert.match(workflow, /\.serverProtocolVersion/u);
  assert.doesNotMatch(workflow, /(?:sync|server)_protocol_version=\d+/u);
  assert.match(fixture, /import \{ getCompatibility \} from "\.\.\/\.\.\/\.\.\/vendor\/lix\/scripts\/compatibility\.mjs"/u);
  assert.match(fixture, /compatibility: getCompatibility\(\)/u);
  assert.match(fixture, /String\(\s*compatibility\.syncProtocolVersion,?\s*\)/u);
  assert.match(fixture, /String\(\s*compatibility\.serverProtocolVersion,?\s*\)/u);
  assert.doesNotMatch(fixture, /"Lix-(?:Sync|Server)-Protocol-Version": "\d+"/u);
});

test("preview protocol probe sends both Lix-owned protocol versions", async () => {
  const workflow = await readFile(new URL("../workflows/pr.yml", import.meta.url), "utf8");
  assert.match(workflow, /Lix-Server-Protocol-Version: \$server_protocol_version/u);
  assert.match(workflow, /Lix-Sync-Protocol-Version: \$sync_protocol_version/u);
});
