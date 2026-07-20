import { execFileSync, spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const signalExitCodes = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGQUIT: 131,
	SIGTERM: 143,
};

let databaseStartAttempted = false;
let databaseStopped = false;
let databaseWasAlreadyRunning = false;
let composeStartAttempted = false;
let composeStopped = false;
let shuttingDown = false;
let webApp;
let composeEnv;

process.on("exit", stopDatabase);
process.on("exit", stopCompose);
for (const signal of Object.keys(signalExitCodes)) {
	process.on(signal, () => handleSignal(signal));
}

databaseWasAlreadyRunning = localSupabaseStatus() !== null;
databaseStartAttempted = true;
const database = spawnSync(pnpm, ["--dir", "database", "start"], {
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
const supabaseKey = localSupabase.PUBLISHABLE_KEY ?? localSupabase.ANON_KEY;
const supabaseSecretKey =
	localSupabase.SECRET_KEY ?? localSupabase.SERVICE_ROLE_KEY;
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

const devPort = process.env.LIXRAY_DEV_PORT ?? "8787";
const devHost = process.env.LIXRAY_DEV_HOST ?? "127.0.0.1";
const composeSupabaseUrl =
	process.env.LIXRAY_COMPOSE_SUPABASE_URL ?? dockerReachableUrl(supabaseUrl);
const internalToken =
	process.env.LIXRAY_INTERNAL_TOKEN ?? "lixray-local-internal-token";

composeEnv = {
	...process.env,
	LIXRAY_DEV_HOST: devHost,
	LIXRAY_DEV_PORT: devPort,
	LIXRAY_SERVER_PORT: process.env.LIXRAY_SERVER_PORT ?? "18080",
	LIXRAY_MINIO_PORT: process.env.LIXRAY_MINIO_PORT ?? "19000",
	LIXRAY_MINIO_CONSOLE_PORT: process.env.LIXRAY_MINIO_CONSOLE_PORT ?? "19001",
	LIXRAY_WORKSPACE_SERVICE_URL:
		process.env.LIXRAY_WORKSPACE_SERVICE_URL ?? "http://lix-server:8080",
	LIXRAY_INTERNAL_TOKEN: internalToken,
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

composeStartAttempted = true;
const stack = spawnSync(
	"docker",
	["compose", "up", "--build", "-d", "lixray-web"],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
		env: composeEnv,
	},
);
if (stack.error) throw stack.error;
if (stack.status !== 0) process.exit(stack.status ?? 1);

webApp = spawn(
	"docker",
	["compose", "logs", "--follow", "lixray-web", "lix-server", "minio"],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
		env: composeEnv,
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
	if (!databaseStartAttempted || databaseWasAlreadyRunning || databaseStopped)
		return;
	databaseStopped = true;
	spawnSync(pnpm, ["--dir", "database", "stop"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
}

function stopCompose() {
	if (!composeStartAttempted || composeStopped) return;
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
		{ headers },
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
