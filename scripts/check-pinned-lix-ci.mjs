import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function selectSuccessfulArtifact(artifacts, runs, revision) {
	for (const artifact of artifacts) {
		if (artifact.expired || artifact.workflow_run?.head_sha !== revision) continue;
		const run = runs.get(artifact.workflow_run.id);
		if (
			run?.path === ".github/workflows/ci.yml" &&
			run.head_sha === revision &&
			run.head_repository?.full_name === "opral/lix" &&
			run.status === "completed" &&
			run.conclusion === "success"
		) return { artifact, run };
	}
	return undefined;
}

function output(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function github(path) {
	return JSON.parse(output("gh", ["api", path]));
}

export async function checkPinnedLixCi({ api = github, git = output, log = console.log } = {}) {
	const gitlink = git("git", ["ls-tree", "HEAD", "vendor/lix"]);
	const revision = gitlink.match(/^160000 commit ([a-f0-9]{40})\s+vendor\/lix$/)?.[1];
	if (!revision) throw new Error("Could not read the pinned vendor/lix revision from HEAD.");
	const name = `lix-browser-sdk-${revision}`;
	const artifacts = api(`repos/opral/lix/actions/artifacts?name=${name}&per_page=100`).artifacts ?? [];
	const runs = new Map();
	for (const artifact of artifacts) {
		const id = artifact.workflow_run?.id;
		if (id && artifact.workflow_run?.head_sha === revision && !runs.has(id)) {
			runs.set(id, api(`repos/opral/lix/actions/runs/${id}`));
		}
	}
	const selected = selectSuccessfulArtifact(artifacts, runs, revision);
	if (!selected) {
		const seen = [...runs.values()].map((run) => `${run.id}: ${run.status}/${run.conclusion ?? "pending"}`).join(", ");
		throw new Error(`Pinned Lix ${revision} has no browser artifact from completed successful CI. Producers: ${seen || "none"}. Check https://github.com/opral/lix/commit/${revision}/checks before starting local acceptance.`);
	}
	log(`Pinned Lix ${revision}: successful CI run ${selected.run.id}, browser artifact ${selected.artifact.id}.`);
	return { revision, runId: selected.run.id, artifactId: selected.artifact.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await checkPinnedLixCi();
}
