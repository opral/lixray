import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
for (const name of ["LIXRAY_WEB_IMAGE", "LIXRAY_SERVER_IMAGE"]) {
	if (!process.env[name]) throw new Error(`${name} must identify a built image`);
}
const env = {
	...process.env,
	LIXRAY_DEV_PORT: process.env.LIXRAY_DEV_PORT ?? "8790",
	LIXRAY_SERVER_PORT: process.env.LIXRAY_SERVER_PORT ?? "18080",
	LIXRAY_MINIO_PORT: process.env.LIXRAY_MINIO_PORT ?? "19000",
	LIXRAY_MINIO_CONSOLE_PORT: process.env.LIXRAY_MINIO_CONSOLE_PORT ?? "19001",
	LIXRAY_STORAGE_PREFIX: process.env.LIXRAY_STORAGE_PREFIX ?? `ci-sync-${randomUUID()}`,
	LIXRAY_INTERNAL_TOKEN: "lixray-local-internal-token",
	// Demo authorization is local to the gateway; no Supabase service or
	// hosted account is needed for these disposable integration fixtures.
	SUPABASE_URL: "http://127.0.0.1:9",
	SUPABASE_JWKS_URL: "http://127.0.0.1:9/auth/v1/.well-known/jwks.json",
};
const args = ["compose", "-f", "compose.yml", "-f", ".github/compose-sync-ci.yml"];
const prepared = spawnSync("docker", [...args, "up", "-d", "--no-build", "lix-server"], {
	cwd, env, stdio: "inherit",
});
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
const web = spawn("docker", [...args, "up", "--no-build", "--no-deps", "lixray-web"], {
	cwd, env, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => web.kill(signal));
}
web.on("error", (error) => { console.error(error); process.exitCode = 1; });
web.on("exit", (code) => { process.exitCode = code ?? 1; });
