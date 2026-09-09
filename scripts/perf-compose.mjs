import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLixServerImage } from "./resolve-lix-server.mjs";

const action = process.argv[2];
if (!["pull", "up"].includes(action)) throw new Error("Expected pull or up.");
const image =
  process.env.LIXRAY_SERVER_IMAGE?.trim() || (await resolveLixServerImage({ mode: "local" })).image;
if (
  action === "pull" &&
  spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0
) {
  console.log(`[lix-server] Image already available: ${image}`);
  process.exit(0);
}
const args = action === "pull" ? ["pull", image] : ["compose", "up", "-d", "lix-server"];
const result = spawnSync("docker", args, {
  cwd: dirname(dirname(fileURLToPath(import.meta.url))),
  stdio: "inherit",
  env: { ...process.env, LIXRAY_SERVER_IMAGE: image, LIXRAY_STORAGE_PREFIX: "local/perf" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
