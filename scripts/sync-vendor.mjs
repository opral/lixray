import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const revisionManifestPath = join(repositoryRoot, "vendor", "revisions.env");
const lixManifestPath = join(repositoryRoot, "vendor", "lix", "Cargo.toml");
const lixToolchainPath = join(repositoryRoot, "vendor", "lix", "rust-toolchain.toml");
const serverLockfilePath = join(repositoryRoot, "lix-server", "Cargo.lock");

const lixLockPackages = [
  "lix_engine",
  "lix_plugin_arena",
  "lix_plugin_layout",
  "lix_plugin_wire",
  "lix_sdk",
  "lix_server_protocol",
  "lix_slatedb_storage",
];

export function parseRevisionManifest(source) {
  return Object.fromEntries(
    source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2)),
  );
}

export function renderRevisionManifest(source, revisions) {
  let rendered = source;
  for (const [key, revision] of Object.entries(revisions)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (!pattern.test(rendered)) {
      throw new Error(`Revision manifest is missing ${key}`);
    }
    rendered = rendered.replace(pattern, `${key}=${revision}`);
  }
  return rendered;
}

export function parseCargoLockPackages(source) {
  const packages = new Map();
  for (const block of source.split("[[package]]").slice(1)) {
    const name = /^\s*name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.set(name, version);
  }
  return packages;
}

export function workspacePackageVersion(source) {
  return /^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m.exec(source)?.[1];
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
}

function submoduleRevision(path) {
  return execFileSync("git", ["-C", join(repositoryRoot, path), "rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

async function expectedRevisions() {
  return {
    LIX_REVISION: submoduleRevision("vendor/lix"),
    ATELIER_REVISION: submoduleRevision("vendor/atelier"),
  };
}

async function assertRevisionManifest(revisions) {
  const source = await readFile(revisionManifestPath, "utf8");
  const expected = renderRevisionManifest(source, revisions);
  if (source !== expected) {
    throw new Error(
      "vendor/revisions.env is out of sync with the submodule checkouts; run pnpm vendor:sync",
    );
  }
}

async function assertServerLockfile() {
  const [lockfile, lixManifest] = await Promise.all([
    readFile(serverLockfilePath, "utf8"),
    readFile(lixManifestPath, "utf8"),
  ]);
  const expectedVersion = workspacePackageVersion(lixManifest);
  if (!expectedVersion) {
    throw new Error("Could not read the vendored Lix workspace package version");
  }

  const packages = parseCargoLockPackages(lockfile);
  const mismatches = lixLockPackages
    .filter((name) => packages.get(name) !== expectedVersion)
    .map(
      (name) =>
        `${name}: lockfile=${packages.get(name) ?? "missing"}, vendored-lix=${expectedVersion}`,
    );
  if (mismatches.length > 0) {
    throw new Error(
      `lix-server/Cargo.lock is out of sync with vendor/lix; run pnpm vendor:sync\n${mismatches.join("\n")}`,
    );
  }
}

async function syncCargoLock() {
  const toolchainSource = await readFile(lixToolchainPath, "utf8");
  const toolchain = /channel\s*=\s*"([^"]+)"/.exec(toolchainSource)?.[1];
  if (!toolchain) throw new Error("Could not read the vendored Lix Rust toolchain");

  run("rustup", [
    "run",
    toolchain,
    "cargo",
    "-Z",
    "bindeps",
    "generate-lockfile",
    "--manifest-path",
    "lix-server/Cargo.toml",
  ]);
}

const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(" ")}`);
}

const revisions = await expectedRevisions();
if (checkOnly) {
  await assertRevisionManifest(revisions);
  await assertServerLockfile();
  console.log("Vendored revisions and lix-server/Cargo.lock are synchronized.");
} else {
  await syncCargoLock();
  const source = await readFile(revisionManifestPath, "utf8");
  const rendered = renderRevisionManifest(source, revisions);
  if (source !== rendered) await writeFile(revisionManifestPath, rendered);
  await assertServerLockfile();
  console.log("Synchronized vendored revisions and lix-server/Cargo.lock.");
}
