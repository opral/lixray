import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLixArtifacts } from "../../scripts/lix-ci-artifacts.mjs";
import { findOfficialLixServerImage } from "../../scripts/resolve-lix-server.mjs";

export async function awaitLixArtifacts({
	revision,
	waitForArtifacts = waitForLixArtifacts,
	findServerImage = findOfficialLixServerImage,
	log = console.log,
}) {
	log(`[lix-artifact] GATE selected vendored Lix ${revision}.`);
	const artifactNames = [`lix-browser-sdk-${revision}`];
	const image =
		process.env.LIXRAY_LIX_ARTIFACTS === "off"
			? undefined
			: findServerImage(revision);
	if (image) {
		log(`[lix-artifact] READY exact-revision server image ${image}.`);
	} else {
		artifactNames.push(`lix-server-image-linux-x64-${revision}`);
	}
	return waitForArtifacts({ revision, artifactNames, log });
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const repositoryRoot = dirname(
		dirname(dirname(fileURLToPath(import.meta.url))),
	);
	const lixRoot = join(repositoryRoot, "vendor", "lix");
	const revision = output("git", ["-C", lixRoot, "rev-parse", "HEAD"]);
	await awaitLixArtifacts({ revision });
}

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
