import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLixArtifacts } from "../../scripts/lix-ci-artifacts.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const lixRoot = join(repositoryRoot, "vendor", "lix");
const revision = output("git", ["-C", lixRoot, "rev-parse", "HEAD"]);

console.log(`[lix-artifact] GATE selected vendored Lix ${revision}.`);
await waitForLixArtifacts({
	revision,
	artifactNames: [
		`lix-browser-sdk-${revision}`,
		`lix-server-image-linux-x64-${revision}`,
	],
});

function output(command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status ?? 1}`);
	}
	const value = result.stdout.trim();
	if (!value) throw new Error(`${command} produced no output.`);
	return value;
}
