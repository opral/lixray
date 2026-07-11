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

if (!supabaseUrl || !supabaseKey) {
	throw new Error(
		"Local Supabase did not report API_URL and PUBLISHABLE_KEY (or ANON_KEY).",
	);
}

const webApp = spawn(pnpm, ["--dir", "web-app", "dev"], {
	stdio: "inherit",
	env: {
		...process.env,
		SUPABASE_JWKS_URL: `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
		SUPABASE_PUBLISHABLE_KEY: supabaseKey,
		SUPABASE_URL: supabaseUrl,
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
