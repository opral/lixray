import { spawnSync } from "node:child_process";

export default function globalTeardown() {
	if (process.env.PLAYWRIGHT_BASE_URL) return;

	const containers = spawnSync(
		"docker",
		["ps", "-aq", "--filter", "name=workerd-lixray-e2e-SlateDbContainer"],
		{ encoding: "utf8" },
	);
	if (containers.status !== 0) return;

	const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
	if (ids.length === 0) return;
	spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
}
