import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(label, args) {
	console.log(`\n==> ${label}`);
	const result = spawnSync(pnpm, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
	});

	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Check vendored dependencies", ["vendor:check"]);
run("Prepare generated dependencies", ["--dir", "web-app", "ci:prepare"]);
// Local CI remains exhaustive; the workflow runs tooling in a selected job.
if (!process.argv.includes("--frontend-only")) run("Test repository tooling", ["test:tooling"]);
run("Check formatting", ["--dir", "web-app", "format:check"]);
run("Lint frontend", ["--dir", "web-app", "ci:lint"]);
run("Typecheck and test frontend", ["--dir", "web-app", "ci:check"]);
run("Verify generated files are committed", ["git", "diff", "--exit-code"]);
