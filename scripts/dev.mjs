import { execFileSync, spawn, spawnSync } from "node:child_process";
import process from "node:process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const database = spawnSync(pnpm, ["--dir", "database", "start"], {
	stdio: "inherit",
});

if (database.error) {
	throw database.error;
}
if (database.status !== 0) {
	process.exit(database.status ?? 1);
}

let databaseStopped = false;
process.on("exit", stopDatabase);

const localSupabase = parseEnv(
	execFileSync(
		pnpm,
		["--dir", "database", "exec", "supabase", "status", "-o", "env"],
		{ encoding: "utf8" },
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

const webApp = spawn(pnpm, ["--dir", "web-app", "dev"], {
	stdio: "inherit",
	env: {
		...process.env,
		SUPABASE_JWKS_URL: `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
		SUPABASE_PUBLISHABLE_KEY: supabaseKey,
		SUPABASE_URL: supabaseUrl,
		VITE_LIXRAY_LOCAL_DEV: "1",
		VITE_LIXRAY_LOCAL_DEV_EMAIL: localDevEmail,
		VITE_LIXRAY_LOCAL_DEV_PASSWORD: localDevPassword,
		VITE_SUPABASE_KEY: supabaseKey,
		VITE_SUPABASE_URL: supabaseUrl,
	},
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		webApp.kill(signal);
	});
}

webApp.on("error", (error) => {
	console.error(error);
	process.exit(1);
});
webApp.on("exit", (code, signal) => {
	process.exit(
		signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 0),
	);
});

function stopDatabase() {
	if (databaseStopped) return;
	databaseStopped = true;
	spawnSync(pnpm, ["--dir", "database", "stop"], { stdio: "inherit" });
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
