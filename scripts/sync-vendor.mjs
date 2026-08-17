import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lixWorkspaceManifestPath = join(repositoryRoot, "vendor", "lix", "Cargo.toml");
const lixToolchainPath = join(repositoryRoot, "vendor", "lix", "rust-toolchain.toml");
const serverLockfilePath = join(repositoryRoot, "lix-server", "Cargo.lock");
const pnpmLockfilePath = join(repositoryRoot, "pnpm-lock.yaml");

const lixLockPackages = [
  { name: "lix", manifest: "packages/lix/Cargo.toml" },
  {
    name: "lix-storage-slatedb",
    manifest: "packages/storage-slatedb/Cargo.toml",
  },
];

export function parseCargoLockPackages(source) {
  const packages = new Map();
  for (const block of source.split("[[package]]").slice(1)) {
    const name = /^\s*name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.set(name, version);
  }
  return packages;
}

export function packageVersion(source, workspaceSource = source) {
  const packageSection = tomlSection(source, "package");
  const directVersion = /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
  if (directVersion) return directVersion;

  if (!/^version\.workspace\s*=\s*true/m.test(packageSection)) return undefined;
  const workspacePackageSection = tomlSection(workspaceSource, "workspace.package");
  return /^version\s*=\s*"([^"]+)"/m.exec(workspacePackageSection)?.[1];
}

function tomlSection(source, name) {
  const marker = `[${name}]`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return "";
  const remainder = source.slice(markerIndex + marker.length);
  const nextSectionIndex = remainder.search(/^\[/m);
  return nextSectionIndex === -1 ? remainder : remainder.slice(0, nextSectionIndex);
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
}

async function assertServerLockfile() {
  const [lockfile, workspaceManifest, ...lixPackageManifests] = await Promise.all([
    readFile(serverLockfilePath, "utf8"),
    readFile(lixWorkspaceManifestPath, "utf8"),
    ...lixLockPackages.map(({ manifest }) =>
      readFile(join(repositoryRoot, "vendor", "lix", manifest), "utf8"),
    ),
  ]);

  const packages = parseCargoLockPackages(lockfile);
  const mismatches = lixLockPackages
    .map(({ name }, index) => ({
      name,
      expectedVersion: packageVersion(lixPackageManifests[index], workspaceManifest),
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

if (checkOnly) {
  await assertServerLockfile();
  await assertPnpmLockfile();
  console.log("Vendored Cargo.lock and pnpm-lock.yaml are synchronized.");
} else {
  await syncCargoLock();
  await syncPnpmLockfile();
  await assertServerLockfile();
  await assertPnpmLockfile();
  console.log("Synchronized vendored Cargo.lock and pnpm-lock.yaml.");
}
