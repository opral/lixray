import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPinnedLixCi } from "./check-pinned-lix-ci.mjs";
import { createIsolatedSupabaseWorkdir } from "./local-supabase.mjs";
import { resolveLixServerImage } from "./resolve-lix-server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = `lixray-ci-local-${process.pid}`;

async function port() {
	for (let attempt = 0; attempt < 20; attempt++) {
		const selected = randomInt(50000, 60000);
		const server = createServer();
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(selected, "127.0.0.1", resolve);
			});
			await new Promise((resolve) => server.close(resolve));
			return String(selected);
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error("Could not find an available local CI port.");
}
const selectedPorts = new Set();
async function uniquePort() {
	let selected;
	do { selected = await port(); } while (selectedPorts.has(selected));
	selectedPorts.add(selected);
	return selected;
}
const localEnv = {
	...process.env,
	CI: "true",
	COMPOSE_PROJECT_NAME: project,
};

async function stackEnv(projectName) {
	const webPort = await uniquePort();
	const serverPort = await uniquePort();
	return {
		...localEnv,
		COMPOSE_PROJECT_NAME: projectName,
		E2E_PORT: webPort,
		LIXRAY_DEV_PORT: webPort,
		LIXRAY_SERVER_PORT: serverPort,
		LIXRAY_ACCOUNT_TEST_SERVICE_URL: `http://127.0.0.1:${serverPort}`,
		LIXRAY_MINIO_PORT: await uniquePort(),
		LIXRAY_MINIO_CONSOLE_PORT: await uniquePort(),
	};
}

function run(label, command, args, env = localEnv) {
	console.log(`\n==> ${label}`);
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${label} failed (${result.status ?? result.signal}).`);
}

await checkPinnedLixCi();
if (process.argv.includes("--check-only")) process.exit(0);
if (Number(process.versions.node.split(".")[0]) !== 24) {
	throw new Error(`Local CI requires Node 24, matching GitHub Actions; found ${process.version}.`);
}

run("Initialize pinned submodules", "git", ["submodule", "update", "--init", "--recursive"]);
run("Install locked dependencies", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
run("Prepare pinned Lix browser SDK", "pnpm", ["--dir", "web-app", "lix:build"], {
	...localEnv,
	LIXRAY_LIX_ARTIFACTS: "only",
	LIXRAY_SKIP_VENDORED_LIX_WASM: "0",
});
run("Source, tooling, and frontend CI", "pnpm", ["run", "ci"]);
run("MCP recovery with real engine", "pnpm", ["--dir", "web-app", "test:mcp-recovery"]);
run("Install Chromium", "pnpm", ["--dir", "web-app", "exec", "playwright", "install", "chromium"]);
run("Atelier styles", "pnpm", ["--filter", "@opral/atelier", "test:styles"]);
run("LixRay styles", "pnpm", ["--dir", "web-app", "test:styles"]);
run("Snapshot and repository opening telemetry", "pnpm", ["--dir", "web-app", "test:snapshot-telemetry"]);
run("MCP Apps browser component tests", "pnpm", ["--dir", "web-app", "test:mcp-ui"]);
run("Published file browser tests", "pnpm", ["--dir", "web-app", "test:published"],
	{ ...localEnv, LIXRAY_PUBLISHED_PORT: await uniquePort() });
run("Recovery and directory browser tests", "pnpm", ["--dir", "web-app", "exec", "playwright", "test", "--config", "playwright.file-component.config.ts", "recovery.spec.ts", "directory.spec.ts", "home-history.spec.ts"],
	{ ...localEnv, LIXRAY_COMPONENT_PORT: await uniquePort() });

const isolatedDatabase = await createIsolatedSupabaseWorkdir();
const databaseEnv = {
	...localEnv,
	LIXRAY_SUPABASE_WORKDIR: isolatedDatabase.workdir,
	LIXRAY_SUPABASE_PROJECT_ID: isolatedDatabase.projectId,
	LIXRAY_SUPABASE_API_URL: isolatedDatabase.apiUrl,
	LIXRAY_SUPABASE_DISCARD_DATA: "1",
};
try {
	run("Start isolated local database", "pnpm", ["--dir", "database", "start:ci"], databaseEnv);
	run("Database policies and functions", "pnpm", ["--dir", "database", "test"], databaseEnv);
	run("Database OAuth lifecycle", "pnpm", ["--dir", "database", "test:oauth"], databaseEnv);
} finally {
	run("Stop isolated local database", "node", ["scripts/local-supabase.mjs", "stop"], databaseEnv);
	await rm(isolatedDatabase.workdir, { recursive: true, force: true });
}

const { image: serverImage } = await resolveLixServerImage({ mode: "local", allowBuild: true });
if (!serverImage) throw new Error("Pinned Lix server image could not be resolved or built locally.");
const e2eStackEnv = await stackEnv(project);
const e2eDatabase = await createIsolatedSupabaseWorkdir();
const e2eEnv = {
	...e2eStackEnv,
	LIXRAY_SUPABASE_WORKDIR: e2eDatabase.workdir,
	LIXRAY_SUPABASE_PROJECT_ID: e2eDatabase.projectId,
	LIXRAY_SUPABASE_API_URL: e2eDatabase.apiUrl,
	LIXRAY_SUPABASE_DISCARD_DATA: "1",
};
try {
	run("Authenticated Compose E2E", "pnpm", ["test:e2e"], { ...e2eEnv, LIXRAY_SERVER_IMAGE: serverImage });
} finally {
	run("Stop authenticated E2E services", "node", ["scripts/dev.mjs", "--down"], e2eEnv);
	run("Remove authenticated E2E containers and volumes", "docker", ["compose", "down", "--volumes", "--remove-orphans"], e2eEnv);
	await rm(e2eDatabase.workdir, { recursive: true, force: true });
}

const prepared = join(root, ".lixray-ci", "vendored-lix-sdk");
await mkdir(join(prepared, "js-sdk"), { recursive: true });
await mkdir(join(prepared, "storage-opfs"), { recursive: true });
await cp(join(root, "vendor/lix/packages/js-sdk/dist"), join(prepared, "js-sdk/dist"), { recursive: true, force: true });
await cp(join(root, "vendor/lix/packages/storage-opfs/dist"), join(prepared, "storage-opfs/dist"), { recursive: true, force: true });
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const webImage = `lixray-web:ci-local-${revision.slice(0, 12)}`;
run("Build deployable web image", "docker", ["build", "-f", "web-app/Dockerfile", "-t", webImage,
	...(process.env.LIXRAY_DOCKER_BUILD_NETWORK ? ["--network", process.env.LIXRAY_DOCKER_BUILD_NETWORK] : []),
	"--build-arg", "VITE_SUPABASE_URL=https://example.invalid",
	"--build-arg", "VITE_SUPABASE_KEY=ci-public-placeholder",
	"--build-arg", `RAILWAY_GIT_COMMIT_SHA=${revision}`, "."]);
for (const scenario of ["navigation", "editing", "history", "conflicts", "batching"]) {
	// Chromium can lose loopback requests when Docker changes the host network.
	// Retry with fresh repository state so a partial first run cannot affect it.
	for (let attempt = 0; attempt < 2; attempt++) {
		const syncEnv = {
			...(await stackEnv(`${project}-${scenario}-${attempt}`)),
			LIXRAY_WEB_IMAGE: webImage,
			LIXRAY_SERVER_IMAGE: serverImage,
			LIXRAY_INTERNAL_TOKEN: "lixray-local-internal-token",
			PLAYWRIGHT_SYNC_LOCAL: "1",
		};
		syncEnv.LIXRAY_LIX_SERVICE_URL = `http://127.0.0.1:${syncEnv.LIXRAY_SERVER_PORT}`;
		try {
			run(`Built-image browser integration: ${scenario}`, "pnpm", ["--dir", "web-app", "exec", "playwright", "test", "tests/e2e/sync-preview.spec.ts", "--grep", `@${scenario}`], syncEnv);
			break;
		} catch (error) {
			if (attempt === 1) throw error;
			console.warn(`Retrying ${scenario} on a fresh disposable stack after ${error.message}`);
		} finally {
			run("Stop disposable integration services", "docker", ["compose", "-f", "compose.yml", "-f", ".github/compose-sync-ci.yml", "down", "--volumes"], syncEnv);
		}
	}
}
console.log("\nLocal CI acceptance passed. GitHub provenance, other OS runners, and production promotion remain remote gates.");
