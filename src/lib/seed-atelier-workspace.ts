import type { JsonValue, Lix } from "@lix-js/sdk";

const seedFiles = [
	{
		id: "lixray-dev:readme",
		path: "/README.md",
		contents: `# LixRay + Atelier

This in-memory workspace is the first Atelier integration slice in LixRay.

## What this proves

- Atelier mounts inside a LixRay route.
- Markdown files can be opened and edited.
- Files and workspace history render from a browser-hosted Lix.

The next slice will replace this seed with the selected LixRay workspace.
`,
	},
	{
		id: "lixray-dev:launch-plan",
		path: "/docs/launch-plan.md",
		contents: `# Launch plan

1. Render Atelier at the canonical workspace route.
2. Connect the selected remote LixRay workspace.
3. Synchronize file routes with the browser URL.
4. Add LixRay-owned logo and sharing slots.
`,
	},
	{
		id: "lixray-dev:metrics",
		path: "/metrics.csv",
		contents: `metric,value\nfiles,3\nworkspaces,1\n`,
	},
] as const;

export async function seedAtelierWorkspace(lix: Lix): Promise<void> {
	await lix.execute("INSERT INTO lix_directory (path) VALUES ($1)", ["/docs/"]);

	for (const file of seedFiles) {
		await lix.execute(
			"INSERT INTO lix_file (id, path, data) VALUES ($1, $2, $3)",
			[file.id, file.path, new TextEncoder().encode(file.contents)],
		);
	}

	await lix.createBranch({ name: "Seed workspace" });
	await seedInitialAtelierState(lix);
}

async function seedInitialAtelierState(lix: Lix): Promise<void> {
	// This dev fixture mirrors Atelier's private persisted layout schema. Production
	// workspace setup should use a public Atelier initializer instead of copying it.
	const readme = seedFiles[0];
	const fileInstance = `atelier_file:${readme.id}`;
	const uiState: JsonValue = {
		focusedPanel: "central",
		panels: {
			left: {
				views: [{ instance: "files-default", kind: "atelier_files" }],
				activeInstance: "files-default",
			},
			central: {
				views: [
					{
						instance: fileInstance,
						kind: "atelier_file",
						state: {
							fileId: readme.id,
							filePath: readme.path,
							atelier: { label: "README.md" },
						},
					},
				],
				activeInstance: fileInstance,
			},
			right: {
				views: [{ instance: "history-default", kind: "atelier_history" }],
				activeInstance: "history-default",
			},
		},
		layout: { sizes: { left: 20, central: 50, right: 30 } },
	};

	await lix.execute(
		"INSERT INTO lix_key_value_by_branch (key, value, lixcol_branch_id, lixcol_global, lixcol_untracked) VALUES ($1, $2, $3, $4, $5)",
		["atelier_ui_state", uiState, "global", true, true],
	);
	await lix.execute(
		"INSERT INTO lix_key_value_by_branch (key, value, lixcol_branch_id, lixcol_global, lixcol_untracked) VALUES ($1, $2, $3, $4, $5)",
		["atelier_active_file_id", readme.id, "global", true, true],
	);
}
