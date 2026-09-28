import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const defaultRepository = "opral/lix";
const defaultApiRoot = "https://api.github.com";

export async function installBrowserArtifact({
	revision,
	sdkRoot,
	opfsStorageRoot,
	log = console.log,
	waitForArtifactMs = Number(process.env.LIX_CI_ARTIFACT_WAIT_MS ?? 0),
	retryIntervalMs = 20_000,
}) {
	const downloaded = await downloadArtifact({
		artifactName: `lix-browser-sdk-${revision}`,
		manifestPath: "ci-artifact/browser.json",
		revision,
		log,
		waitForArtifactMs,
		retryIntervalMs,
	});
	if (!downloaded) return undefined;

	try {
		await requireFile(join(downloaded.root, "packages/js-sdk/dist/index.js"));
		await requireFile(join(downloaded.root, "packages/js-sdk/dist/migration.js"));
		await requireFile(join(downloaded.root, "packages/js-sdk/dist/migration-wasm/lix_js_sdk.js"));
		await requireFile(join(downloaded.root, "packages/js-sdk/dist/migration-wasm/lix_js_sdk_bg.wasm"));
		await requireFile(join(downloaded.root, "packages/storage-opfs/dist/migration.worker.js"));
		await requireFile(
			join(downloaded.root, "packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm"),
		);
		await requireFile(
			join(downloaded.root, "packages/storage-opfs/dist/index.js"),
		);
		await replaceDirectory(
			join(downloaded.root, "packages/js-sdk/dist"),
			join(sdkRoot, "dist"),
		);
		await replaceDirectory(
			join(downloaded.root, "packages/storage-opfs/dist"),
			join(opfsStorageRoot, "dist"),
		);
		return downloaded.artifact;
	} finally {
		await rm(downloaded.temporaryRoot, { recursive: true, force: true });
	}
}

export async function installServerImageArtifact({
	revision,
	destination,
	log = console.log,
	waitForArtifactMs = Number(process.env.LIX_CI_ARTIFACT_WAIT_MS ?? 0),
	retryIntervalMs = 20_000,
}) {
	const target = "linux-x64";
	const downloaded = await downloadArtifact({
		artifactName: `lix-server-image-${target}-${revision}`,
		manifestPath: `server-${target}.json`,
		validateManifest: validateServerImageManifest,
		revision,
		log,
		waitForArtifactMs,
		retryIntervalMs,
	});
	if (!downloaded) return undefined;

	try {
		const imageSource = join(downloaded.root, "lix-server-image.tar");
		await requireFile(imageSource);
		await cp(imageSource, destination);
		return downloaded.artifact;
	} finally {
		await rm(downloaded.temporaryRoot, { recursive: true, force: true });
	}
}

export function validateServerImageManifest(manifest, revision) {
	if (
		!/^[a-f0-9]{40}$/.test(revision) ||
		manifest.schemaVersion !== 1 ||
		manifest.kind !== "lix-server-image" ||
		manifest.target !== "linux-x64" ||
		manifest.sourceRevision !== revision ||
		manifest.image !== `lix-server-ci:${revision}`
	) {
		throw new Error("unexpected Lix server image manifest");
	}
}

async function downloadArtifact({
	artifactName,
	manifestPath,
	validateManifest,
	revision,
	log,
	waitForArtifactMs,
	retryIntervalMs,
}) {
	if (process.env.LIXRAY_LIX_ARTIFACTS === "off") {
		log(`[lix-artifact] Lookup disabled for ${revision}; no artifact installed.`);
		return undefined;
	}
	const repository = process.env.LIX_CI_ARTIFACT_REPOSITORY ?? defaultRepository;
	const apiRoot = process.env.LIX_CI_ARTIFACT_API_ROOT ?? defaultApiRoot;
	const producer = `https://github.com/${repository}/commit/${revision}/checks`;
	log(`[lix-artifact] Looking for ${repository}/${artifactName}.`);
	const deadline = Date.now() + (Number.isFinite(waitForArtifactMs) ? Math.max(0, waitForArtifactMs) : 0);
	for (;;) {
		let candidate;
		try {
			candidate = await findReusableArtifact({ apiRoot, artifactName, log, repository, revision });
		} catch (error) {
			if (process.env.LIXRAY_LIX_ARTIFACTS === "only") {
				throw new Error(`Required Lix CI artifact ${artifactName} could not be checked (${errorMessage(error)}). Check its producer: ${producer}`);
			}
			log(`[lix-artifact] Lookup unavailable (${errorMessage(error)}); no artifact installed. Producer: ${producer}`);
			return undefined;
		}
		if (candidate) {
			const downloaded = await verifiedArtifact({
				artifact: candidate.artifact, artifactName, manifestPath,
				validateManifest, revision,
				run: candidate.run, runId: candidate.runId, log,
			});
			if (downloaded) return downloaded;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const delay = Math.min(Number.isFinite(retryIntervalMs) ? Math.max(1, retryIntervalMs) : 20_000, remaining);
		log(`[lix-artifact] ${artifactName} is not published yet; retrying in ${Math.ceil(delay / 1000)}s. Producer: ${producer}`);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
	log(`[lix-artifact] MISS ${artifactName}; artifact unavailable. Build it at https://github.com/${repository}/actions/workflows/ci.yml using the artifact-only action, then retry. Producer: ${producer}`);
	if (process.env.LIXRAY_LIX_ARTIFACTS === "only") {
		throw new Error(`Required Lix CI artifact ${artifactName} is unavailable. Check its producer: ${producer}`);
	}
	return undefined;
}

async function findReusableArtifact({
	apiRoot,
	artifactName,
	log,
	repository,
	revision,
}) {
	const response = await githubJson(
		`${apiRoot}/repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
	);
	for (const artifact of (response.artifacts ?? [])
		.filter((candidate) => !candidate.expired)
		.sort((left, right) => right.id - left.id)) {
		const runId = artifact.workflow_run?.id;
		if (!runId || artifact.workflow_run?.head_sha !== revision) continue;

		let run;
		try {
			run = await githubJson(
				`${apiRoot}/repos/${repository}/actions/runs/${runId}`,
			);
		} catch (error) {
			log(
				`[lix-artifact] Could not verify workflow run ${runId} (${errorMessage(error)}).`,
			);
			continue;
		}
		if (
			run.path !== ".github/workflows/ci.yml" ||
			run.head_sha !== revision ||
			run.head_repository?.full_name !== repository ||
			!["pull_request", "push", "workflow_dispatch"].includes(run.event)
		) {
			log(
				`[lix-artifact] Ignoring ${artifactName} from unexpected workflow producer ${runId}.`,
			);
			continue;
		}
		if (run.status === "completed" && run.conclusion !== "success") {
			log(
				`[lix-artifact] Ignoring ${artifactName} from failed run ${runId}: ${run.conclusion ?? "unknown"}.`,
			);
			continue;
		}
		return { artifact, run, runId };
	}
	return undefined;
}

async function verifiedArtifact({
	artifact,
	artifactName,
	manifestPath,
	validateManifest,
	revision,
	run,
	runId,
	log,
}) {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "lix-ci-artifact-"));
	const extracted = join(temporaryRoot, "extracted");
	try {
		const bytes = await githubBytes(artifact.archive_download_url);
		verifyDigest(bytes, artifact.digest);
		await extractZip(bytes, extracted);
		const manifest = JSON.parse(
			await readFile(join(extracted, manifestPath), "utf8"),
		);
		if (validateManifest) {
			validateManifest(manifest, revision);
		} else if (manifest.sourceRevision !== revision) {
			throw new Error(
				`artifact revision ${manifest.sourceRevision} does not match ${revision}`,
			);
		}
		log(
			`[lix-artifact] HIT ${artifactName} from run ${runId} (${run.status}/${run.conclusion ?? "artifact job complete"}, ${artifact.digest ?? "digest unavailable"}).`,
		);
		return {
			artifact: {
				artifactId: artifact.id,
				digest: artifact.digest,
				runId,
			},
			root: extracted,
			temporaryRoot,
		};
	} catch (error) {
		await rm(temporaryRoot, { recursive: true, force: true });
		if (isArtifactAuthorizationError(error)) {
			throw new Error(
				`downloading cross-repository Actions artifacts requires LIX_ACTIONS_READ_TOKEN (${errorMessage(error)})`,
			);
		}
		log(
			`[lix-artifact] Rejected artifact ${artifact.id} (${errorMessage(error)}).`,
		);
		return undefined;
	}
}

async function extractZip(bytes, destination) {
	const { unzipSync } = await import("fflate");
	const entries = unzipSync(bytes);
	for (const [name, contents] of Object.entries(entries)) {
		const normalized = name.replaceAll("\\", "/");
		const segments = normalized.split("/").filter(Boolean);
		if (
			normalized.startsWith("/") ||
			segments.length === 0 ||
			segments.some((segment) => segment === "." || segment === "..")
		) {
			throw new Error(`unsafe artifact path ${name}`);
		}
		const output = join(destination, ...segments);
		if (normalized.endsWith("/")) {
			await mkdir(output, { recursive: true });
			continue;
		}
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, contents);
	}
}

async function githubJson(url) {
	const response = await githubFetch(url);
	return response.json();
}

async function githubBytes(url) {
	const response = await githubFetch(url);
	return new Uint8Array(await response.arrayBuffer());
}

async function githubFetch(url) {
	const token =
		process.env.LIX_CI_ARTIFACT_GITHUB_TOKEN ??
		process.env.GH_TOKEN ??
		process.env.GITHUB_TOKEN ??
		githubCliToken();
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
	const response = await fetch(url, { headers, redirect: "follow" });
	if (!response.ok) {
		throw new Error(`GitHub returned HTTP ${response.status} for ${url}`);
	}
	return response;
}

function githubCliToken() {
	const result = spawnSync("gh", ["auth", "token"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function verifyDigest(bytes, digest) {
	if (!digest) return;
	const [algorithm, expected] = digest.split(":", 2);
	if (algorithm !== "sha256" || !expected) {
		throw new Error(`unsupported artifact digest ${digest}`);
	}
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`artifact digest mismatch: expected ${digest}, got sha256:${actual}`,
		);
	}
}

async function replaceDirectory(source, destination) {
	await rm(destination, { recursive: true, force: true });
	await cp(source, destination, { recursive: true });
}

async function requireFile(path) {
	if ((await stat(path)).isFile()) return;
	throw new Error(`Expected artifact file ${path}`);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isArtifactAuthorizationError(error) {
	const message = errorMessage(error);
	return message.includes("HTTP 401") || message.includes("HTTP 403");
}
