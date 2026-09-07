import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const scenario of ["enough", "recover", "exhausted"]) {
  test(`disk cleanup: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "runner-space-"));
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    writeFileSync(join(root, "df"), `#!/bin/bash\navailable=1\nif [[ "$SCENARIO" = enough ]] || { [[ "$SCENARIO" = recover ]] && [[ -s "$CALLS" ]]; }; then available=20971520; fi\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 30000000 0 %s 0%% /\\n' "$available"\n`, { mode: 0o755 });
    writeFileSync(join(root, "sudo"), '#!/bin/bash\necho "$*" >> "$CALLS"\n', { mode: 0o755 });
    try {
      const result = spawnSync("bash", [join(import.meta.dirname, "prepare-linux-runner.sh")], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_WORKSPACE: root, MINIMUM_FREE_GB: "10", SCENARIO: scenario, CALLS: calls }, encoding: "utf8",
      });
      const actions = readFileSync(calls, "utf8").trim();
      assert.equal(result.status, scenario === "exhausted" ? 1 : 0, result.stderr);
      if (scenario === "enough") assert.equal(actions, "");
      if (scenario === "recover") assert.equal(actions, "rm -rf /usr/local/lib/android");
      if (scenario === "exhausted") assert.match(result.stderr, /Could not free/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
