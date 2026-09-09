import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installServerImageArtifact } from "./lix-ci-artifacts.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lixRoot = join(repositoryRoot, "vendor", "lix");

export async function resolveLixServerImage({
	mode,
	allowBuild = false,
	installArtifact = installServerImageArtifact,
	inspectImage = inspectDigest,
}) {
	if (mode !== "ci" && mode !== "local") {
		throw new Error(`Unsupported Lix server resolution mode ${mode}.`);
	}

	const sourceRevision = output("git", ["-C", lixRoot, "rev-parse", "HEAD"]);
	const inputHash = serverInputHash();
	const officialTags = [
		`ghcr.io/opral/lix-server:content-${inputHash}`,
		`ghcr.io/opral/lix-server:sha-${sourceRevision}`,
	];
	console.log(`[lix-server] Selected vendored Lix ${sourceRevision}.`);
	console.log(`[lix-server] Server input hash ${inputHash}.`);

	const existingOfficialImage = officialImage(officialTags, inspectImage);
	if (existingOfficialImage) {
		return {
			image: existingOfficialImage,
			source: "lix-main-image",
			sourceRevision,
		};
	}
	if (mode === "ci") {
		const previewTag = previewImageTag(sourceRevision);
		const previewDigest = inspectImage(previewTag);
		if (previewDigest) {
			const image = `${previewRepository()}@${previewDigest}`;
			console.log(
				`[lix-server] HIT previously published feature image ${previewTag} as ${image}.`,
			);
			return {
				image,
				source: "lixray-feature-image",
				sourceRevision,
			};
		}
	}

	for (const localTag of [
		`lix-server-ci:${sourceRevision}`,
		`lixray-lix-server-local:${sourceRevision}`,
	]) {
		if (mode === "local" && localImageMatches(localTag, sourceRevision)) {
			console.log(`[lix-server] REUSE local image ${localTag}.`);
			return { image: localTag, source: "local-image", sourceRevision };
		}
	}

	const artifactDirectory = join(repositoryRoot, ".lixray-ci", "lix-server");
	const imageArchive = join(artifactDirectory, "lix-server-image.tar");
	await mkdir(artifactDirectory, { recursive: true });

	let artifact;
	try {
		artifact = await installArtifact({
			destination: imageArchive,
			revision: sourceRevision,
		});
	} catch (error) {
		if (process.env.LIXRAY_LIX_ARTIFACTS === "only") throw error;
		console.log(
			`[lix-server] Artifact install failed (${errorMessage(error)}); compiling from source.`,
		);
	}

	if (artifact) {
		console.log(
			`[lix-server] Loading tested server artifact from Lix CI run ${artifact.runId}.`,
		);
		run("docker", ["load", "--input", imageArchive]);
		const loadedTag = `lix-server-ci:${sourceRevision}`;
		if (mode === "local") {
			console.log(`[lix-server] Reused precompiled Lix CI image ${loadedTag}.`);
			return {
				image: loadedTag,
				source: "lix-ci-artifact",
				sourceRevision,
			};
		}

		const published = publishPreviewImage({ loadedTag, sourceRevision });
		console.log(`[lix-server] Reused precompiled Lix CI image ${published}.`);
		return {
			image: published,
			source: "lix-ci-artifact",
			sourceRevision,
		};
	}

	// A matching main image may finish publishing while the artifact resolver
	// waits for the exact-revision Lix workflows. Recheck before paying for a
	// fallback build.
	const publishedOfficialImage = officialImage(officialTags, inspectImage);
	if (publishedOfficialImage) {
		return {
			image: publishedOfficialImage,
			source: "lix-main-image",
			sourceRevision,
		};
	}

	if (!allowBuild || mode === "ci") {
		console.log(
			`[lix-server] Missing artifact for ${sourceRevision}. Build it at https://github.com/opral/lix/actions/workflows/ci.yml.`,
		);
		return { image: "", source: "missing", sourceRevision };
	}

	console.log(
		`[lix-server] SOURCE BUILD ${sourceRevision}; no reusable main image or successful CI artifact was available.`,
	);
	if (mode === "local") {
		const localTag = `lixray-lix-server-local:${sourceRevision}`;
		run("docker", [
			"build",
			"--file",
			join(lixRoot, "packages", "server", "Dockerfile"),
			"--tag",
			localTag,
			"--label",
			`org.opencontainers.image.revision=${sourceRevision}`,
			lixRoot,
		]);
		console.log(
			`[lix-server] Finished local fallback source build ${localTag}.`,
		);
		return { image: localTag, source: "source-build", sourceRevision };
	}

}

export function findOfficialLixServerImage(
	sourceRevision,
	inspectImage = inspectDigest,
) {
	return officialImage(
		[`ghcr.io/opral/lix-server:sha-${sourceRevision}`],
		inspectImage,
	);
}

function officialImage(tags, inspectImage) {
	for (const tag of tags) {
		const digest = inspectImage(tag);
		if (!digest) continue;
		const image = `ghcr.io/opral/lix-server@${digest}`;
		console.log(
			`[lix-server] HIT official precompiled image ${tag} as ${image}.`,
		);
		return image;
	}
	return undefined;
}

function serverInputHash() {
	const rootEntries = output("git", [
		"-C",
		lixRoot,
		"ls-tree",
		"HEAD",
		"--",
		".cargo",
		".dockerignore",
		"Cargo.lock",
		"Cargo.toml",
		"rust-toolchain.toml",
	]);
	const recursiveEntries = output("git", [
		"-C",
		lixRoot,
		"ls-tree",
		"-r",
		"HEAD",
		"--",
		"packages/lix",
		"packages/lix-schema",
		"packages/server",
		"packages/storage-slatedb",
		"plugins",
	]);
	const result = spawnSync("git", ["hash-object", "--stdin"], {
		cwd: lixRoot,
		encoding: "utf8",
		input: `${rootEntries}\n${recursiveEntries}\n`,
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error("Could not compute Lix server input hash.");
	}
	return result.stdout.trim();
}

function publishPreviewImage({ loadedTag, sourceRevision }) {
	const repository = previewRepository();
	const tag = previewImageTag(sourceRevision);
	run("docker", ["tag", loadedTag, tag]);
	console.log(`[lix-server] Publishing the tested image as ${tag}.`);
	run("docker", ["push", tag]);
	return `${repository}@${requiredDigest(tag)}`;
}

function previewRepository() {
	return `ghcr.io/${(
		process.env.GITHUB_REPOSITORY_OWNER ?? "opral"
	).toLowerCase()}/lixray-server`;
}

function previewImageTag(sourceRevision) {
	return `${previewRepository()}:lix-${sourceRevision}`;
}

function localImageMatches(image, revision) {
	const result = spawnSync(
		"docker",
		[
			"image",
			"inspect",
			image,
			"--format",
			'{{ index .Config.Labels "org.opencontainers.image.revision" }}',
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	return result.status === 0 && result.stdout.trim() === revision;
}

function inspectDigest(image) {
	const result = spawnSync(
		"docker",
		[
			"buildx",
			"imagetools",
			"inspect",
			image,
			"--format",
			"{{json .Manifest.Digest}}",
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	if (result.status !== 0) return undefined;
	return result.stdout.trim().replaceAll('"', "") || undefined;
}

function requiredDigest(image) {
	const digest = inspectDigest(image);
	if (!digest)
		throw new Error(`Could not resolve immutable digest for ${image}.`);
	return digest;
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

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
