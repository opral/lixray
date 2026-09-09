import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { protocolUrlFromLixUrl } from "../../scripts/check-production-lix.mjs";

export function provisionProductionCanary({ env = process.env, spawnImpl = spawnSync } = {}) {
  const { connectionUrl } = protocolUrlFromLixUrl(env.LIXRAY_CANARY_LIX_URL);
  if (!env.RAILWAY_PRODUCTION_ENVIRONMENT) {
    throw new Error("RAILWAY_PRODUCTION_ENVIRONMENT is required.");
  }
  const id = connectionUrl.pathname.split("/").at(-1);
  // The canary owns existing data. A missing prefix is a release failure;
  // never substitute creation or fall back to the disposable preview IDs.
  const result = spawnImpl("bash", [
    fileURLToPath(new URL("./provision-preview-repositories.sh", import.meta.url)),
    "adopt-existing", id,
  ], {
    stdio: "inherit",
    env: {
      ...env,
      PREVIEW_URL: connectionUrl.origin,
      RAILWAY_TARGET_ENVIRONMENT: env.RAILWAY_PRODUCTION_ENVIRONMENT,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Production canary adoption failed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionProductionCanary();
}
