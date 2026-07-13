import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const serverDirectory = path.resolve("dist/server");
const config = JSON.parse(
	await readFile(path.join(serverDirectory, "wrangler.json"), "utf8"),
);

const forbiddenBindings = [
	...(config.durable_objects?.bindings ?? []),
	...(config.containers ?? []),
	...(config.r2_buckets ?? []),
	...(config.d1_databases ?? []),
	...(config.kv_namespaces ?? []),
	...(config.services ?? []),
];
if (forbiddenBindings.length > 0) {
	throw new Error("The preview Worker contains a state or service binding");
}
if (Object.keys(config.exports ?? {}).length > 0) {
	throw new Error("The preview Worker exports a Durable Object implementation");
}

for (const file of await javascriptFiles(serverDirectory)) {
	const source = await readFile(file, "utf8");
	if (
		source.includes("SlateDbContainer") ||
		source.includes("@cloudflare/containers")
	) {
		throw new Error(`The preview bundle contains container code: ${file}`);
	}
}

console.log(
	"Preview bundle has no state bindings or container implementation.",
);

async function javascriptFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await javascriptFiles(file)));
		else if (entry.name.endsWith(".js")) files.push(file);
	}
	return files;
}
