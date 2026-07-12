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
let shuttingDown = false;
let webApp;

process.on("exit", stopDatabase);
for (const signal of Object.keys(signalExitCodes)) {
  process.on(signal, () => handleSignal(signal));
}

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
const localSupabase = parseEnv(
  execFileSync(
		pnpm,
		["--dir", "database", "exec", "supabase", "status", "-o", "env"],
		{ cwd: repositoryRoot, encoding: "utf8" },
  ),
);
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

await ensureLocalDevUser({
  email: localDevEmail,
  password: localDevPassword,
  secretKey: supabaseSecretKey,
  supabaseUrl,
});

const devPort = process.env.LIXRAY_DEV_PORT ?? "8787";
const devHost = process.env.LIXRAY_DEV_HOST ?? "localhost";

webApp = spawn(
  pnpm,
  [
    "--dir",
    "web-app",
    "exec",
    "vite",
    "dev",
    "--host",
    devHost,
    "--port",
    devPort,
  ],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
    env: {
      ...process.env,
      SLATEDB_STORAGE: process.env.SLATEDB_STORAGE ?? "memory",
      SUPABASE_JWKS_URL: `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
      SUPABASE_PUBLISHABLE_KEY: supabaseKey,
      SUPABASE_URL: supabaseUrl,
      VITE_LIXRAY_LOCAL_DEV: "1",
      VITE_LIXRAY_LOCAL_DEV_EMAIL: localDevEmail,
      VITE_LIXRAY_LOCAL_DEV_PASSWORD: localDevPassword,
      VITE_SUPABASE_KEY: supabaseKey,
      VITE_SUPABASE_URL: supabaseUrl,
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

  if (
    webApp &&
    webApp.exitCode === null &&
    webApp.signalCode === null &&
    webApp.kill(signal)
  ) {
    return;
  }

  process.exit(signalExitCodes[signal] ?? 1);
}

function stopDatabase() {
  if (!databaseStartAttempted || databaseStopped) return;
  databaseStopped = true;
	spawnSync(pnpm, ["--dir", "database", "stop"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
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
