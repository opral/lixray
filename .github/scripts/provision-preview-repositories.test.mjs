import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve(import.meta.dirname, "provision-preview-repositories.sh");
for (const [name, failure, expected, args = []] of [
  ["success", "none", 0],
  ["production adoption", "none", 0, ["adopt-existing", "11111111-1111-4111-8111-111111111111"]],
  ["HTTP wake failure", "wake", 22],
  ["SSH relay wake lag", "relay", 0],
  ["operator failure", "operator", 17],
  ["registration response failure", "register", 19],
  ["revocation failure", "revoke", 1],
]) {
  test(`ephemeral SSH identity cleanup runs after ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "lixray-ssh-test-"));
    try {
      const calls = join(dir, "calls.jsonl");
      const railway = join(dir, "railway");
      const sshCalls = join(dir, "ssh.jsonl");
      await writeFile(join(dir, "curl"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.at(-1) !== 'https://preview.example/healthz' || !args.includes('--fail')) process.exit(34);
require('node:fs').appendFileSync(process.env.MOCK_CALLS, JSON.stringify(['wake']) + '\\n');
if (process.env.MOCK_FAILURE === 'wake') process.exit(22);
`, { mode: 0o700 });
      await writeFile(join(dir, "ssh"), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.MOCK_SSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
      await writeFile(
        railway,
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + '\\n');
if (args[2] === 'add') {
  const file = args[args.indexOf('--key') + 1];
  if (!fs.readFileSync(file, 'utf8').startsWith('ssh-ed25519 ')) process.exit(31);
  if (process.env.MOCK_FAILURE === 'register') process.exit(19);
} else if (args[2] === 'remove' && process.env.MOCK_FAILURE === 'revoke') {
  process.exit(23);
} else if (args[1] !== 'keys') {
  const file = args[args.indexOf('--identity-file') + 1];
  if (!fs.existsSync(file)) process.exit(32);
  if (process.env.MOCK_FAILURE === 'relay' && !fs.existsSync(process.env.MOCK_CALLS + '.relay')) {
    fs.writeFileSync(process.env.MOCK_CALLS + '.relay', 'once');
    console.error("No active deployment for 'fixture'");
    process.exit(255);
  }
  const cp = require('node:child_process');
  for (const target of ['fixture@ssh.railway.com', 'fixture@example.com']) {
    const result = cp.spawnSync('ssh', ['-i', file, '-T', target, 'true'], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(33);
  }
  if (process.env.MOCK_FAILURE === 'operator') process.exit(17);
}
`,
        { mode: 0o700 },
      );
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          RAILWAY_BIN: railway,
          PREVIEW_URL: "https://preview.example",
          RAILWAY_API_TOKEN: "fixture-token",
          RAILWAY_PROJECT_ID: "project",
          RAILWAY_TARGET_ENVIRONMENT: "preview",
          RAILWAY_WEB_SERVICE: "web",
          MOCK_CALLS: calls,
          MOCK_SSH_CALLS: sshCalls,
          PATH: `${dir}:${process.env.PATH}`,
          MOCK_FAILURE: failure,
        },
      });
      assert.equal(result.status, expected, result.stderr);
      const recorded = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(recorded[0], ["wake"]);
      if (failure === "wake") {
        assert.deepEqual(recorded, [["wake"]]);
        return;
      }
      const added = recorded.find((args) => args[2] === "add");
      const removed = recorded.find((args) => args[2] === "remove");
      assert.ok(added);
      assert.match(removed?.[3] ?? "", /^SHA256:/);
      assert.equal(recorded.at(-1)[2], "remove");
      const publicKey = added[added.indexOf("--key") + 1];
      await assert.rejects(access(publicKey));
      await assert.rejects(access(publicKey.slice(0, -4)));
      if (failure !== "register") {
        const ssh = (await readFile(sshCalls, "utf8")).trim().split("\n").map(JSON.parse);
        assert.deepEqual(ssh[0].slice(0, 4), ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"]);
        assert.deepEqual(ssh[1], ssh[0].slice(4).map((arg) => arg === "fixture@ssh.railway.com" ? "fixture@example.com" : arg));
        // No alternate trust store or configuration override: OpenSSH retains
        // existing host keys and rejects mismatches under accept-new.
        assert.ok(ssh.flat().every((arg) => !arg.includes("UserKnownHostsFile") && arg !== "-F"));
        const commands = recorded.filter((args) => args.includes("--identity-file"));
        assert.equal(commands.length, failure === "relay" ? 2 : 1);
        const command = commands[0];
        assert.deepEqual(command.slice(-(args.length ? 2 + args.length : 3)), [
          "node",
          "/app/web-app/scripts/provision-repositories.mjs",
          ...(args.length ? args : ["create-new"]),
        ]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
