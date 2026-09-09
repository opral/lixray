import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveLixServerImage } from "./resolve-lix-server.mjs";
import { waitForSupabaseAuthDatabase } from "./supabase-readiness.mjs";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// The stack outlives dev.mjs on purpose: stopping stateful services on every
// iteration (each Ctrl-C or script kill) SIGKILLed lix-server mid-write and
// left repository stores in a state whose next open hangs. `--down` is the
// explicit teardown.
const teardownRequested = process.argv.includes("--down");
const signalExitCodes = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGQUIT: 131,
	SIGTERM: 143,
};

let databaseStopped = false;
let composeStopped = false;
let shuttingDown = false;
let webApp;
let composeEnv;

if (teardownRequested) {
	stopCompose();
	stopDatabase();
	process.exit(0);
}

const devHost = process.env.LIXRAY_DEV_HOST?.trim() || "127.0.0.1";
const devPort = process.env.LIXRAY_DEV_PORT?.trim() || "8787";
const serverPort = process.env.LIXRAY_SERVER_PORT?.trim() || "18080";
const minioPort = process.env.LIXRAY_MINIO_PORT?.trim() || "19000";
const minioConsolePort =
	process.env.LIXRAY_MINIO_CONSOLE_PORT?.trim() || "19001";
const internalToken = "lixray-local-internal-token";

await assertPortAvailable(devHost, devPort);

for (const signal of Object.keys(signalExitCodes)) {
	process.on(signal, () => handleSignal(signal));
}

const databaseScript = process.env.CI ? "start:ci" : "start";
const database = spawnSync(pnpm, ["--dir", "database", databaseScript], {
	cwd: repositoryRoot,
	stdio: "inherit",
});

if (database.error) {
	throw database.error;
}
if (database.status !== 0) {
	process.exit(database.status ?? 1);
}
const localSupabase = localSupabaseStatus();
if (!localSupabase) {
	throw new Error(
		"Local Supabase did not report its URL, publishable key, and secret key.",
	);
}
const supabaseUrl = localSupabase.API_URL;
const supabaseKey = localSupabase.PUBLISHABLE_KEY;
const supabaseSecretKey = localSupabase.SECRET_KEY;
const localDevEmail = "dev@lixray.local";
const localDevPassword = "lixray-local-dev";

if (!supabaseUrl || !supabaseKey || !supabaseSecretKey) {
	throw new Error(
		"Local Supabase did not report its URL, publishable key, and secret key.",
	);
}

await waitForSupabaseAuth(supabaseUrl);

await ensureLocalDevUser({
	email: localDevEmail,
	password: localDevPassword,
	secretKey: supabaseSecretKey,
	supabaseUrl,
});

const composeSupabaseUrl = dockerReachableUrl(supabaseUrl);
const explicitServerImage = process.env.LIXRAY_SERVER_IMAGE?.trim();
const selectedServerImage = explicitServerImage
	? explicitServerImage
	: (await resolveLixServerImage({ mode: "local" })).image;
if (explicitServerImage) {
	console.log(
		`[lix-server] Using explicit LIXRAY_SERVER_IMAGE=${explicitServerImage}.`,
	);
}

composeEnv = {
	...process.env,
	LIXRAY_DEV_HOST: devHost,
	LIXRAY_DEV_PORT: devPort,
	LIXRAY_SERVER_PORT: serverPort,
	LIXRAY_PUBLIC_URL: `http://${devHost}:${devPort}`,
	LIXRAY_MINIO_PORT: minioPort,
	LIXRAY_MINIO_CONSOLE_PORT: minioConsolePort,
	LIXRAY_LIX_SERVICE_URL: "http://lix-server:8080",
	LIXRAY_INTERNAL_TOKEN: internalToken,
	LIXRAY_SERVER_IMAGE: selectedServerImage,
	SUPABASE_URL: composeSupabaseUrl,
	SUPABASE_JWKS_URL: `${composeSupabaseUrl}/auth/v1/.well-known/jwks.json`,
	SUPABASE_JWT_ISSUER_URL: supabaseUrl,
	SUPABASE_PUBLISHABLE_KEY: supabaseKey,
	VITE_LIXRAY_LOCAL_DEV: "1",
	VITE_LIXRAY_LOCAL_DEV_EMAIL: localDevEmail,
	VITE_LIXRAY_LOCAL_DEV_PASSWORD: localDevPassword,
	VITE_SUPABASE_KEY: supabaseKey,
	VITE_SUPABASE_URL: supabaseUrl,
};

const staleWebContainer = spawnSync(
	"docker",
	["compose", "stop", "lixray-web"],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
		env: composeEnv,
	},
);
if (staleWebContainer.error) throw staleWebContainer.error;
if (staleWebContainer.status !== 0) {
	process.exit(staleWebContainer.status ?? 1);
}

const stackArguments = ["compose", "up"];
stackArguments.push("-d", "lix-server");

const stack = spawnSync("docker", stackArguments, {
	cwd: repositoryRoot,
	stdio: "inherit",
	env: composeEnv,
});
if (stack.error) throw stack.error;
if (stack.status !== 0) process.exit(stack.status ?? 1);

// Building the Lix service can take several minutes and consume substantial
// Docker storage. Recheck the database-backed Auth API after the build so a
// crashed Postgres container cannot leave Vite advertising a broken MCP OAuth
// endpoint as ready.
await waitForSupabaseAuthDatabase({
	secretKey: supabaseSecretKey,
	supabaseUrl,
});

webApp = spawn(
	pnpm,
	[
		"--dir",
		"web-app",
		"exec",
		"vite",
		"--host",
		devHost,
		"--port",
		devPort,
		"--strictPort",
	],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
		env: {
			...composeEnv,
			LIXRAY_LIX_SERVICE_URL: `http://127.0.0.1:${serverPort}`,
			SUPABASE_URL: supabaseUrl,
			SUPABASE_JWKS_URL: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
		},
	},
);

webApp.on("error", (error) => {
	console.error(error);
	process.exit(1);
});
webApp.on("exit", (code, signal) => {
	process.exit(signal ? (signalExitCodes[signal] ?? 1) : (code ?? 0));
});

function handleSignal(signal) {
	if (shuttingDown) return;
	shuttingDown = true;

	if (webApp && webApp.exitCode === null && webApp.signalCode === null) {
		webApp.kill(signal);
	}

	process.exit(signalExitCodes[signal] ?? 1);
}

function stopDatabase() {
	if (databaseStopped) return;
	databaseStopped = true;
	spawnSync(pnpm, ["--dir", "database", "stop"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
}

function stopCompose() {
	if (composeStopped) return;
	composeStopped = true;
	spawnSync(
		"docker",
		["compose", "stop", "lixray-web", "lix-server", "minio"],
		{
			cwd: repositoryRoot,
			stdio: "inherit",
			env: composeEnv,
		},
	);
}

async function assertPortAvailable(host, port) {
	const probe = createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", (error) => {
			if (error.code === "EADDRINUSE") {
				reject(
					new Error(
						`LixRay dev port ${port} is already in use. Stop the existing local dev process before running pnpm dev.`,
					),
				);
				return;
			}
			reject(error);
		});
		probe.listen(Number(port), host, () => {
			probe.close(resolve);
		});
	});
}

function dockerReachableUrl(value) {
	const url = new URL(value);
	if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
		url.hostname = "host.docker.internal";
	}
	return url.toString().replace(/\/$/, "");
}

async function waitForSupabaseAuth(supabaseUrl) {
	const healthUrl = new URL("/auth/v1/health", supabaseUrl);
	const timeoutMs = 120_000;
	const deadline = Date.now() + timeoutMs;

	console.log(`Waiting for local Supabase auth at ${healthUrl.origin}...`);
	while (Date.now() < deadline) {
		try {
			const response = await fetch(healthUrl, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
		} catch {
			// Supabase has not accepted connections yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	throw new Error(
		`Local Supabase auth did not become ready within ${timeoutMs / 1_000} seconds.`,
	);
}

function localSupabaseStatus() {
	try {
		return parseEnv(
			execFileSync(
				pnpm,
				["--dir", "database", "exec", "supabase", "status", "-o", "env"],
				{
					cwd: repositoryRoot,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			),
		);
	} catch {
		return null;
	}
}

async function ensureLocalDevUser({ email, password, secretKey, supabaseUrl }) {
	const headers = {
		apikey: secretKey,
		Authorization: `Bearer ${secretKey}`,
		"Content-Type": "application/json",
	};
	const usersResponse = await fetch(
		`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`,
		{
			headers,
		},
	);
	if (!usersResponse.ok) {
		throw new Error(
			`Unable to inspect local development users: ${await usersResponse.text()}`,
		);
	}
	const users = await usersResponse.json();
	const existingUser = users.users?.find((user) => user.email === email);
	const endpoint = existingUser
		? `${supabaseUrl}/auth/v1/admin/users/${existingUser.id}`
		: `${supabaseUrl}/auth/v1/admin/users`;
	const response = await fetch(endpoint, {
		method: existingUser ? "PUT" : "POST",
		headers,
		body: JSON.stringify({
			email,
			password,
			email_confirm: true,
			user_metadata: { full_name: "Local Developer" },
		}),
	});

	if (response.ok) return;
	const error = await response.text();
	throw new Error(`Unable to create the local development user: ${error}`);
}

function parseEnv(output) {
	return Object.fromEntries(
		output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#") && line.includes("="))
			.map((line) => {
				const separator = line.indexOf("=");
				const key = line.slice(0, separator);
				const value = line.slice(separator + 1).replace(/^['"]|['"]$/g, "");
				return [key, value];
			}),
	);
}
