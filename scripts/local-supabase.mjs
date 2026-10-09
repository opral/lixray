import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const isolatedPorts = [
	["api", "port"],
	["db", "port"],
	["db", "shadow_port"],
];

export async function createIsolatedSupabaseWorkdir({
	sourceDirectory = join(repositoryRoot, "database"),
	workdirParent = tmpdir(),
	selectPort = findFreePort,
} = {}) {
	const projectId = `lixray_ci_${process.pid}_${randomUUID().slice(0, 8)}`;
	const workdir = await mkdtemp(join(workdirParent, "lixray-supabase-ci-"));
	try {
		const sourceSupabase = join(sourceDirectory, "supabase");
		const targetSupabase = join(workdir, "supabase");
		await mkdir(targetSupabase, { recursive: true });
		const sourceEntries = new Set(await readdir(sourceSupabase));
		for (const entry of [
			"config.toml",
			"migrations",
			"tests",
			"seed.sql",
			"functions",
		]) {
			if (!sourceEntries.has(entry)) continue;
			await cp(join(sourceSupabase, entry), join(targetSupabase, entry), {
				recursive: true,
			});
		}
		const configPath = join(targetSupabase, "config.toml");
		let config = await readFile(configPath, "utf8");
		config = config.replace(
			/^project_id\s*=.*$/m,
			`project_id = "${projectId}"`,
		);
		if (!config.includes(`project_id = "${projectId}"`)) {
			throw new Error("Supabase config is missing its project_id setting.");
		}

		const ports = new Set();
		for (const [section, setting] of isolatedPorts) {
			let selected;
			do {
				selected = await selectPort();
			} while (ports.has(selected));
			ports.add(selected);
			config = setTomlSetting(config, section, setting, String(selected));
		}
		await writeFile(configPath, config);
		const apiPort = readTomlNumber(config, "api", "port");
		// Make local issuer allowlists match this project's port without mutating
		// the checked-in production migrations or their committed fixtures.
		for (const directory of ["migrations", "tests"]) {
			await rewriteLocalIssuer(join(targetSupabase, directory), apiPort);
		}
		return {
			workdir,
			projectId,
			apiUrl: `http://127.0.0.1:${apiPort}`,
		};
	} catch (error) {
		await rm(workdir, { recursive: true, force: true });
		throw error;
	}
}

async function rewriteLocalIssuer(directory, apiPort) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await rewriteLocalIssuer(path, apiPort);
		} else if (entry.isFile() && entry.name.endsWith(".sql")) {
			const source = await readFile(path, "utf8");
			const updated = source
				.replaceAll(
					"http://127.0.0.1:54321/auth/v1",
					`http://127.0.0.1:${apiPort}/auth/v1`,
				)
				.replaceAll(
					"http://localhost:54321/auth/v1",
					`http://localhost:${apiPort}/auth/v1`,
				);
			if (updated !== source) await writeFile(path, updated);
		}
	}
}

export function getLocalSupabaseSettings({
	env = process.env,
	root = repositoryRoot,
} = {}) {
	const workdir = resolve(
		env.LIXRAY_SUPABASE_WORKDIR || join(root, "database"),
	);
	const configPath = join(workdir, "supabase", "config.toml");
	const config = readFileSync(configPath, "utf8");
	const projectId = readTomlString(config, "", "project_id");
	if (!projectId)
		throw new Error(`Supabase project_id is missing in ${configPath}.`);
	if (
		env.LIXRAY_SUPABASE_PROJECT_ID &&
		env.LIXRAY_SUPABASE_PROJECT_ID !== projectId
	) {
		throw new Error(
			`Supabase project ID in the environment does not match ${configPath}.`,
		);
	}
	const apiPort = readTomlNumber(config, "api", "port") ?? 54321;
	return {
		workdir,
		projectId,
		apiUrl: env.LIXRAY_SUPABASE_API_URL || `http://127.0.0.1:${apiPort}`,
	};
}

export function supabaseCommandArgs(args, { workdir, projectId } = {}) {
	if (!args.length) throw new Error("A Supabase CLI command is required.");
	if (args.some((arg) => arg === "--workdir" || arg.startsWith("--workdir="))) {
		throw new Error(
			"Local Supabase commands must use the selected project workdir.",
		);
	}
	const command = args[0];
	if (command === "stop" && args.includes("--all")) {
		throw new Error("Local Supabase cleanup must be scoped to one project.");
	}
	const scopedArgs = [...args];
	if (command === "stop") {
		const projectIdIndex = scopedArgs.indexOf("--project-id");
		const inlineProjectId = scopedArgs.find((arg) =>
			arg.startsWith("--project-id="),
		);
		const selectedProjectId =
			inlineProjectId?.slice("--project-id=".length) ??
			(projectIdIndex === -1 ? undefined : scopedArgs[projectIdIndex + 1]);
		if (selectedProjectId === undefined)
			scopedArgs.push("--project-id", projectId);
		else if (selectedProjectId !== projectId) {
			throw new Error(
				"Local Supabase cleanup must target the selected project.",
			);
		}
	}
	if (
		command === "stop" &&
		process.env.LIXRAY_SUPABASE_DISCARD_DATA === "1" &&
		!scopedArgs.includes("--no-backup")
	) {
		scopedArgs.push("--no-backup");
	}
	return ["--workdir", workdir, ...scopedArgs];
}

// Keep the helper importable by scripts that need the selected project's API
// URL and Docker container names without running a CLI command as a side effect.
function readTomlString(config, section, setting) {
	const value = readTomlValue(config, section, setting);
	return value?.replace(/^['"]|['"]$/g, "");
}

function readTomlNumber(config, section, setting) {
	const value = readTomlValue(config, section, setting);
	return value === undefined ? undefined : Number(value);
}

function readTomlValue(config, section, setting) {
	const sectionHeader = section ? `[${section}]` : null;
	const lines = config.split("\n");
	let inSection = !sectionHeader;
	for (const line of lines) {
		const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
		if (header !== undefined) {
			inSection = header === section;
			continue;
		}
		if (!inSection) continue;
		const match = line.match(
			new RegExp(`^\\s*${setting}\\s*=\\s*(.*?)\\s*(?:#.*)?$`),
		);
		if (match) return match[1];
	}
	return undefined;
}

function setTomlSetting(config, section, setting, value) {
	const lines = config.split("\n");
	const header = `[${section}]`;
	let sectionIndex = lines.indexOf(header);
	if (sectionIndex === -1) {
		if (lines.at(-1) !== "") lines.push("");
		lines.push(header);
		sectionIndex = lines.length - 1;
	}
	let endIndex = sectionIndex + 1;
	while (
		endIndex < lines.length &&
		!/^\s*\[[^\]]+\]\s*$/.test(lines[endIndex])
	) {
		endIndex++;
	}
	while (endIndex > sectionIndex + 1 && lines[endIndex - 1].trim() === "") {
		endIndex--;
	}
	const settingPattern = new RegExp(`^\\s*${setting}\\s*=`);
	const existingIndex = lines.findIndex(
		(line, index) =>
			index > sectionIndex && index < endIndex && settingPattern.test(line),
	);
	if (existingIndex >= 0) lines[existingIndex] = `${setting} = ${value}`;
	else lines.splice(endIndex, 0, `${setting} = ${value}`);
	return lines.join("\n");
}

async function findFreePort() {
	const server = createServer();
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const { port } = server.address();
	await new Promise((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	);
	return port;
}

function run(args) {
	const settings = getLocalSupabaseSettings();
	const cliArgs = supabaseCommandArgs(args, settings);
	const result = spawnSync(
		pnpm,
		["--dir", "database", "exec", "supabase", ...cliArgs],
		{
			cwd: repositoryRoot,
			stdio: "inherit",
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	run(process.argv.slice(2));
}
