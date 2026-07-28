import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const lixServerContainerId = run("docker", ["compose", "ps", "--quiet", "lix-server"], {
  capture: true,
}).trim();
const lixServerWasRunning = lixServerContainerId
  ? run("docker", ["inspect", "--format", "{{.State.Running}}", lixServerContainerId], {
      capture: true,
    }).trim() === "true"
  : false;

try {
  if (lixServerWasRunning) {
    run("docker", ["compose", "stop", "lix-server"]);
  }

  run(pnpm, [
    "--dir",
    "database",
    "exec",
    "supabase",
    "db",
    "query",
    "--local",
    "--file",
    "./scripts/reset-onboarding.sql",
  ]);
  run(pnpm, [
    "--dir",
    "database",
    "exec",
    "supabase",
    "db",
    "query",
    "--local",
    [
      "select 'profiles' as record, count(*)::bigint as remaining from public.profiles",
      "union all select 'namespaces', count(*)::bigint from public.namespaces",
      "union all select 'lixes', count(*)::bigint from public.lixes",
      "union all select 'mcp_lix_connections', count(*)::bigint from public.mcp_lix_connections",
      "union all select 'oauth_clients', count(*)::bigint from auth.oauth_clients",
      "union all select 'oauth_consents', count(*)::bigint from auth.oauth_consents",
      "union all select 'refresh_tokens', count(*)::bigint from auth.refresh_tokens",
      "order by record",
    ].join(" "),
  ]);
  run("docker", [
    "compose",
    "--profile",
    "tools",
    "run",
    "--rm",
    "--no-deps",
    "onboarding-storage-reset",
  ]);
} finally {
  if (lixServerWasRunning) {
    run("docker", ["compose", "start", "lix-server"]);
  }
}

console.log("Onboarding data reset. Supabase users and OAuth credentials were preserved.");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "unknown status"}`,
    );
  }
  return options.capture ? (result.stdout ?? "") : "";
}
