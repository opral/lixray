import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getLocalSupabaseSettings } from "../../scripts/local-supabase.mjs";

// Addresses only the local CLI container; never uses linked project credentials.
const { projectId } = getLocalSupabaseSettings();
execFileSync(
	"docker",
	[
		"exec",
		"-i",
		`supabase_db_${projectId}`,
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
