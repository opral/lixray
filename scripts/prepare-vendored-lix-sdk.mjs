import { cp, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDist = join(workspaceRoot, "node_modules", "@lix-js", "sdk-release", "dist");
const sdkRoot = join(workspaceRoot, "vendor", "lix", "packages", "js-sdk");
const sdkDist = join(sdkRoot, "dist");
const tsc = join(workspaceRoot, "web-app", "node_modules", "typescript", "bin", "tsc");

await requireDirectory(
  releaseDist,
  "Install workspace dependencies before building the vendored Lix SDK.",
);
await requireDirectory(
  sdkRoot,
  "Initialize the vendor/lix submodule before installing dependencies.",
);

await rm(sdkDist, { recursive: true, force: true });
await cp(releaseDist, sdkDist, { recursive: true });

const wasm = spawnSync(process.execPath, [join(sdkRoot, "scripts", "build-wasm.js")], {
  stdio: "inherit",
});
if (wasm.error) throw wasm.error;
if (wasm.status !== 0) process.exit(wasm.status ?? 1);

const compiled = spawnSync(process.execPath, [tsc, "-p", join(sdkRoot, "tsconfig.json")], {
  stdio: "inherit",
});
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

async function requireDirectory(path, message) {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // Use the actionable error below.
  }
  throw new Error(message);
}
