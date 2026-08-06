import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(label, args, extraEnv = {}) {
	console.log(`\n==> ${label}`);
	const result = spawnSync(pnpm, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
		env: { ...process.env, ...extraEnv },
	});

	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Check vendored dependencies", ["vendor:check"]);
run("Prepare generated dependencies", ["--dir", "web-app", "ci:prepare"]);
run("Test development environment", ["test:dev"]);
run("Test performance harness", ["perf:test"]);
run("Test CI scripts", ["test:ci-scripts"]);
run("Test production canary", ["test:production-canary"]);
run("Check formatting", ["--dir", "web-app", "format:check"]);
run("Lint frontend", ["--dir", "web-app", "ci:lint"]);
run("Typecheck and test frontend", ["--dir", "web-app", "ci:check"]);
run("Build frontend", ["--dir", "web-app", "lix:build"]);
run("Build frontend bundle", ["--dir", "web-app", "ci:build"]);
run(
	"Build Railway target",
	["--dir", "web-app", "ci:build:node"],
	{
		VITE_SUPABASE_URL: "https://example.invalid",
		VITE_SUPABASE_KEY: "ci-public-placeholder",
	},
);
run("Verify generated files are committed", ["git", "diff", "--exit-code"]);
