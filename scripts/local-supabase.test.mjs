import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	createIsolatedSupabaseWorkdir,
	getLocalSupabaseSettings,
	supabaseCommandArgs,
} from "./local-supabase.mjs";

const temporaryDirectories = [];
after(async () => {
	await Promise.all(
		temporaryDirectories.map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

test("isolated Supabase workdirs copy only local project inputs and assign unique ports", async () => {
	const sourceDirectory = await mkdtemp(
		join(tmpdir(), "lixray-supabase-source-"),
	);
	const workdirParent = await mkdtemp(
		join(tmpdir(), "lixray-supabase-workdirs-"),
	);
	temporaryDirectories.push(sourceDirectory, workdirParent);
	const source = join(sourceDirectory, "supabase");
	await mkdir(join(source, "migrations"), { recursive: true });
	await mkdir(join(source, ".temp"), { recursive: true });
	await writeFile(
		join(source, "config.toml"),
		'project_id = "lixray"\n\n[api]\nenabled = true\n\n[db]\nmajor_version = 17\n',
	);
	await writeFile(
		join(source, "migrations", "migration.sql"),
		"select 'http://127.0.0.1:54321/auth/v1', 'http://localhost:54321/auth/v1';\n",
	);
	await writeFile(
		join(source, ".temp", "linked-project"),
		"must not be copied",
	);
	let nextPort = 41000;
	const project = await createIsolatedSupabaseWorkdir({
		sourceDirectory,
		workdirParent,
		selectPort: async () => nextPort++,
	});
	const isolatedConfig = await readFile(
		join(project.workdir, "supabase", "config.toml"),
		"utf8",
	);
	const isolatedMigration = await readFile(
		join(project.workdir, "supabase", "migrations", "migration.sql"),
		"utf8",
	);
	const copiedEntries = await readdir(join(project.workdir, "supabase"));
	const settings = getLocalSupabaseSettings({
		env: { LIXRAY_SUPABASE_WORKDIR: project.workdir },
	});
	assert.match(project.projectId, /^lixray_ci_/);
	assert.equal(settings.projectId, project.projectId);
	assert.equal(settings.apiUrl, project.apiUrl);
	assert.equal(project.apiUrl, "http://127.0.0.1:41000");
	assert.match(
		isolatedConfig,
		/\[db\]\nmajor_version = 17\nport = 41001\nshadow_port = 41002/,
	);
	assert.ok(copiedEntries.includes("migrations"));
	assert.ok(!copiedEntries.includes(".temp"));
	assert.match(isolatedMigration, /127\.0\.0\.1:41000\/auth\/v1/);
	assert.match(isolatedMigration, /localhost:41000\/auth\/v1/);
	assert.match(
		await readFile(join(source, "migrations", "migration.sql"), "utf8"),
		/127\.0\.0\.1:54321\/auth\/v1/,
	);
	assert.equal(
		await readFile(join(source, "config.toml"), "utf8"),
		'project_id = "lixray"\n\n[api]\nenabled = true\n\n[db]\nmajor_version = 17\n',
	);
	await rm(project.workdir, { recursive: true, force: true });
});

test("Supabase stop commands stay scoped to one configured project", () => {
	assert.deepEqual(
		supabaseCommandArgs(["stop", "--no-backup"], {
			workdir: "/tmp/lixray-supabase-ci",
			projectId: "lixray_ci_1_deadbeef",
		}),
		[
			"--workdir",
			"/tmp/lixray-supabase-ci",
			"stop",
			"--no-backup",
			"--project-id",
			"lixray_ci_1_deadbeef",
		],
	);
	assert.throws(
		() =>
			supabaseCommandArgs(["stop", "--all"], {
				workdir: "/tmp/lixray-supabase-ci",
				projectId: "lixray_ci_1_deadbeef",
			}),
		/ must be scoped to one project/,
	);
	assert.throws(
		() =>
			supabaseCommandArgs(["stop", "--project-id", "lixray"], {
				workdir: "/tmp/lixray-supabase-ci",
				projectId: "lixray_ci_1_deadbeef",
			}),
		/ must target the selected project/,
	);
	assert.throws(
		() =>
			supabaseCommandArgs(["status", "--workdir", "/tmp/other-project"], {
				workdir: "/tmp/lixray-supabase-ci",
				projectId: "lixray_ci_1_deadbeef",
			}),
		/ must use the selected project workdir/,
	);
});

test("default Supabase settings retain the checked-in developer project", () => {
	const settings = getLocalSupabaseSettings({ env: {} });
	assert.equal(settings.workdir, join(process.cwd(), "database"));
	assert.equal(settings.projectId, "lixray");
	assert.equal(settings.apiUrl, "http://127.0.0.1:54321");
});
