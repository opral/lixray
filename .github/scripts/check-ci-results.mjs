import { pathToFileURL } from "node:url";

export function checkCiResults(needs, previewRequested = false, forkPullRequest = false) {
	const requireSuccess = (job) => {
		if (needs[job]?.result !== "success") throw new Error(`${job} did not succeed: ${needs[job]?.result ?? "missing"}`);
	};
	requireSuccess("changes");
	const selected = needs.changes.outputs;
	if (forkPullRequest && (selected.e2e === "true" || previewRequested)) {
		throw new Error("Fork PR requires credential-dependent integration. Review the changes, then run full CI on a branch in this repository before merging; fork PRs cannot publish images or deploy previews.");
	}
	for (const [lane, jobs] of Object.entries({
		fast: ["fast"],
		frontend: ["fast", "frontend", "sdk"],
		tooling: ["tooling"],
		database: ["database"],
		e2e: ["sdk", "server-image", "web-image", "e2e", "sync"],
	})) {
		if (selected[lane] === "true") jobs.forEach(requireSuccess);
	}
	if (previewRequested) ["sdk", "server-image", "web-image"].forEach(requireSuccess);
	for (const [name, job] of Object.entries(needs)) {
		if (!["success", "skipped"].includes(job.result)) throw new Error(`${name} finished with ${job.result}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const forkPullRequest = process.env.FORK_PULL_REQUEST === "true";
	checkCiResults(JSON.parse(process.env.RESULTS), process.env.PREVIEW_REQUESTED === "true", forkPullRequest);
	console.log("All selected checks passed");
}
