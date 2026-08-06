import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const revisionManifestPath = join(repositoryRoot, "vendor", "revisions.env");
const lixToolchainPath = join(repositoryRoot, "vendor", "lix", "rust-toolchain.toml");
const serverLockfilePath = join(repositoryRoot, "lix-server", "Cargo.lock");
const pnpmLockfilePath = join(repositoryRoot, "pnpm-lock.yaml");

const lixLockPackages = [
  { name: "lix", manifest: "packages/lix/Cargo.toml" },
  {
    name: "lix-server-protocol",
    manifest: "packages/server-protocol/Cargo.toml",
  },
  {
    name: "lix-storage-slatedb",
    manifest: "packages/slatedb-storage/Cargo.toml",
  },
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

export function packageVersion(source) {
  return /^\[package\][\s\S]*?^version = "([^"]+)"/m.exec(source)?.[1];
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
  const [lockfile, ...lixPackageManifests] = await Promise.all([
    readFile(serverLockfilePath, "utf8"),
    ...lixLockPackages.map(({ manifest }) =>
      readFile(join(repositoryRoot, "vendor", "lix", manifest), "utf8"),
    ),
  ]);

  const packages = parseCargoLockPackages(lockfile);
  const mismatches = lixLockPackages
    .map(({ name }, index) => ({
      name,
      expectedVersion: packageVersion(lixPackageManifests[index]),
    }))
    .flatMap(({ name, expectedVersion }) =>
      expectedVersion && packages.get(name) === expectedVersion
        ? []
        : [
            `${name}: lockfile=${packages.get(name) ?? "missing"}, vendored-lix=${expectedVersion ?? "missing"}`,
          ],
    );
  if (mismatches.length > 0) {
    throw new Error(
      `lix-server/Cargo.lock is out of sync with vendor/lix; run pnpm vendor:sync\n${mismatches.join("\n")}`,
    );
  }
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

async function syncPnpmLockfile() {
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
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
  await assertPnpmLockfile();
  console.log("Vendored revisions, Cargo.lock, and pnpm-lock.yaml are synchronized.");
} else {
  await syncCargoLock();
  await syncPnpmLockfile();
  const source = await readFile(revisionManifestPath, "utf8");
  const rendered = renderRevisionManifest(source, revisions);
  if (source !== rendered) await writeFile(revisionManifestPath, rendered);
  await assertServerLockfile();
  await assertPnpmLockfile();
  console.log("Synchronized vendored revisions, Cargo.lock, and pnpm-lock.yaml.");
}
