import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const verifyArchives = process.argv.includes("--verify-archives");
const sources = [
	{
		submodule: "vendor/lix",
		repository: "opral/lix",
		revisionArg: "LIX_REV",
		checksumArg: "LIX_ARCHIVE_SHA256",
		dockerfiles: ["web-app/Dockerfile", "lix-server/Dockerfile"],
	},
	{
		submodule: "vendor/atelier",
		repository: "opral/atelier",
		revisionArg: "ATELIER_REV",
		checksumArg: "ATELIER_ARCHIVE_SHA256",
		dockerfiles: ["web-app/Dockerfile"],
	},
];

const errors = [];

for (const source of sources) {
	const gitlink = indexedGitlink(source.submodule);
	const fallbacks = source.dockerfiles.map((dockerfile) => ({
		dockerfile,
		revision: dockerArg(dockerfile, source.revisionArg, 40),
		checksum: dockerArg(dockerfile, source.checksumArg, 64),
	}));

	for (const fallback of fallbacks) {
		if (fallback.revision !== gitlink) {
			errors.push(
				`${fallback.dockerfile}: ${source.revisionArg}=${fallback.revision} does not match ${source.submodule} gitlink ${gitlink}`,
			);
		}
	}

	if (verifyArchives && fallbacks.every(({ revision }) => revision === gitlink)) {
		const archiveUrl = `https://github.com/${source.repository}/archive/${gitlink}.tar.gz`;
		const response = await fetch(archiveUrl);
		if (!response.ok) {
			errors.push(
				`${source.submodule}: failed to download ${archiveUrl}: ${response.status} ${response.statusText}`,
			);
			continue;
		}
		const archive = Buffer.from(await response.arrayBuffer());
		const actualChecksum = createHash("sha256").update(archive).digest("hex");
		for (const fallback of fallbacks) {
			if (fallback.checksum !== actualChecksum) {
				errors.push(
					`${fallback.dockerfile}: ${source.checksumArg}=${fallback.checksum} does not match ${source.submodule} archive checksum ${actualChecksum}`,
				);
			}
		}
	}
}

if (errors.length > 0) {
	console.error("Docker submodule fallback validation failed:\n");
	for (const error of errors) console.error(`- ${error}`);
	console.error(
		"\nUpdate each fallback revision and checksum together with its submodule gitlink.",
	);
	process.exit(1);
}

console.log(
	verifyArchives
		? "Docker submodule fallback revisions and archive checksums are valid."
		: "Docker submodule fallback revisions match the indexed gitlinks.",
);

function indexedGitlink(submodule) {
	const entry = execFileSync("git", ["ls-files", "--stage", "--", submodule], {
		encoding: "utf8",
	}).trim();
	const match = /^160000 ([0-9a-f]{40}) \d+\t/.exec(entry);
	if (!match) {
		throw new Error(`${submodule} is not an indexed git submodule`);
	}
	return match[1];
}

function dockerArg(dockerfile, name, length) {
	const contents = readFileSync(dockerfile, "utf8");
	const pattern = new RegExp(`^ARG\\s+${name}=([0-9a-f]{${length}})\\s*$`, "gm");
	const matches = [...contents.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(
			`${dockerfile} must declare exactly one ${name} as ${length} lowercase hexadecimal characters`,
		);
	}
	return matches[0][1];
}
