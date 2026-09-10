import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Addresses only the local CLI container; never uses linked project credentials.
execFileSync(
	"docker",
	[
		"exec",
		"-i",
		"supabase_db_lixray",
		"psql",
		"-X",
		"-U",
		"postgres",
		"-d",
		"postgres",
		"-v",
		"ON_ERROR_STOP=1",
	],
	{
		input: readFileSync(new URL("../supabase/seed.sql", import.meta.url)),
		stdio: ["pipe", "ignore", "inherit"],
	},
);
