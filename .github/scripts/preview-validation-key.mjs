import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function previewValidationKey({ tree, url, deploymentId, serverDeploymentId, webImage, serverImage, now = Date.now() }) {
  for (const value of [tree, url, deploymentId, serverDeploymentId, webImage, serverImage]) {
    if (typeof value !== "string" || !value) throw new Error("Missing preview validation input");
  }
  // Scope reuse to this source tree, deployed artifacts and one UTC hour. A
  // manual rerun bypasses restoration in the workflow to force fresh tests.
  const hash = createHash("sha256").update(JSON.stringify({ tree, url, deploymentId, serverDeploymentId, webImage, serverImage })).digest("hex");
  return `preview-sync-v1-${Math.floor(now / 3_600_000)}-${hash}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = previewValidationKey({
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    url: process.env.PREVIEW_URL,
    deploymentId: process.env.DEPLOYMENT_ID,
    serverDeploymentId: process.env.SERVER_DEPLOYMENT_ID,
    webImage: process.env.WEB_IMAGE,
    serverImage: process.env.SERVER_IMAGE,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  console.log(`Preview validation key: ${key}`);
}
