import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpmLockfilePath = join(repositoryRoot, "pnpm-lock.yaml");

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
}

async function assertPnpmLockfile() {
  await readFile(pnpmLockfilePath, "utf8");
  run("pnpm", [
    "install",
    "--lockfile-only",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
}

async function syncPnpmLockfile() {
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
}

const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(" ")}`);
}

if (checkOnly) {
  await assertPnpmLockfile();
  console.log("The vendored pnpm lockfile is synchronized.");
} else {
  await syncPnpmLockfile();
  await assertPnpmLockfile();
  console.log("Synchronized the vendored pnpm lockfile.");
}
