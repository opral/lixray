import { appendFile } from "node:fs/promises";
import { resolveLixServerImage } from "../../scripts/resolve-lix-server.mjs";

const resolved = await resolveLixServerImage({
	mode: "ci",
	allowBuild: process.env.LIXRAY_ALLOW_SOURCE_BUILD !== "false",
});

for (const [name, value] of Object.entries(resolved)) {
	console.log(`[lix-server] ${name}=${value}`);
	if (process.env.GITHUB_OUTPUT) {
		await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
}
