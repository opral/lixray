import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lix } from "@lix-js/sdk";
import type { AtelierDiffSession } from "@opral/atelier";
import { DirectoryView } from "../../src/components/repository-home/directory-view";
import "./fixture.css";

type Entry = { id: string; path: string; content?: Uint8Array };
const dirs: Entry[] = [
	{ id: "docs", path: "/docs" },
	{ id: "hidden-dir", path: "/.cache" },
	{ id: "research", path: "/research" },
	{ id: "nested", path: "/docs/nested" },
];
const files: Entry[] = [
	{
		id: "hidden-file",
		path: "/.secret.md",
		content: new TextEncoder().encode("Hidden"),
	},
	{
		id: "alpha",
		path: "/alpha.md",
		content: new TextEncoder().encode("Alpha"),
	},
	{ id: "beta", path: "/beta.md", content: new TextEncoder().encode("Beta") },
	{ id: "gamma", path: "/gamma.csv", content: new TextEncoder().encode("x,y") },
	{
		id: "child",
		path: "/docs/child.md",
		content: new TextEncoder().encode("Child"),
	},
];
const calls: { sql: string; params: unknown[] }[] = [];
let writeDelay = 0;
let failNextWrite = false;
const observers = new Set<() => void>();
const parent = (path: string) =>
	path
		.replace(/\/$/, "")
		.slice(0, path.replace(/\/$/, "").lastIndexOf("/") + 1);
const row = (entry: Entry, isDir: boolean) => {
	const values: Record<string, unknown> = {
		...entry,
		name: entry.path.replace(/\/$/, "").split("/").at(-1),
		parent_id:
			dirs.find((d) => `${d.path}/` === parent(entry.path))?.id ?? null,
		directory_id:
			dirs.find((d) => `${d.path}/` === parent(entry.path))?.id ?? null,
		lixcol_updated_at: "2026-09-01T00:00:00Z",
		kind: isDir ? "directory" : "file",
	};
	return values;
};
const query = (sql: string, params: readonly unknown[] = []) => {
	if (/UNION ALL/i.test(sql))
		return {
			rows: [
				...dirs.map((entry) => row(entry, true)),
				...files.map((entry) => row(entry, false)),
			],
		};
	if (sql.includes("lix_as_of"))
		return { rows: [{ id: "past", path: "/past.md" }] };
	if (sql.includes("information_schema")) return { rows: [{ n: 2 }] };
	if (!sql.includes("lix_directory") && !sql.includes("lix_file"))
		return { rows: [] };
	const isDir = sql.includes("lix_directory");
	let entries = [...(isDir ? dirs : files)];
	if (/lower\(path\)/i.test(sql))
		entries = entries.filter(
			(entry) => entry.path.toLowerCase() === String(params[0]).toLowerCase(),
		);
	else if (/WHERE path = \$1/i.test(sql))
		entries = entries.filter((entry) => entry.path === params[0]);
	else if (/WHERE id = \$1/i.test(sql))
		entries = entries.filter((entry) => entry.id === params[0]);
	return { rows: entries.map((entry) => row(entry, isDir)) };
};
const lix = {
	async openAnotherSession() {
		return {
			beginTransaction: () => lix.beginTransaction(),
			close: async () => {},
		};
	},
	async beginTransaction() {
		const originalDirs = structuredClone(dirs),
			originalFiles = structuredClone(files);
		return {
			execute: (sql: string, params: unknown[] = []) =>
				lix.execute(sql, params as Parameters<Lix["execute"]>[1]),
			commit: async () => {},
			rollback: async () => {
				dirs.splice(0, dirs.length, ...originalDirs);
				files.splice(0, files.length, ...originalFiles);
				for (const update of observers) update();
			},
		};
	},
	observe(sql: string, params: readonly unknown[] = []) {
		let closed = false;
		let pending: ((event: unknown) => void) | undefined;
		const queue: unknown[] = [{ result: query(sql, params) }];
		const update = () => {
			const frame = { result: query(sql, params) };
			if (pending) {
				const resolve = pending;
				pending = undefined;
				resolve(frame);
			} else queue.push(frame);
		};
		observers.add(update);
		return {
			next: () =>
				closed
					? Promise.resolve(null)
					: queue.length
						? Promise.resolve(queue.shift())
						: new Promise((resolve) => {
								pending = resolve;
							}),
			close: () => {
				closed = true;
				observers.delete(update);
				pending?.(null);
			},
		};
	},
	async execute(sql: string, params: unknown[] = []) {
		calls.push({ sql, params });
		if (/^SELECT/i.test(sql)) return query(sql, params);
		if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
		if (writeDelay)
			await new Promise((resolve) => setTimeout(resolve, writeDelay));
		if (failNextWrite) {
			failNextWrite = false;
			throw new Error("Simulated write failure");
		}
		const isDir = sql.includes("lix_directory");
		const entries = isDir ? dirs : files;
		if (/^INSERT/i.test(sql)) {
			const path = String(params[0]);
			const existing = entries.find((entry) => entry.path === path);
			if (existing && /ON CONFLICT/i.test(sql))
				existing.content = params[1] as Uint8Array;
			else if (existing) throw new Error("Path already exists");
			else
				entries.push({
					id: crypto.randomUUID(),
					path,
					...(!isDir ? { content: params[1] as Uint8Array } : {}),
				});
		} else if (/^UPDATE/i.test(sql)) {
			const entry = entries.find((entry) =>
				/WHERE id/i.test(sql)
					? entry.id === params[1]
					: entry.path === params[1],
			);
			if (!entry)
				throw new Error(
					`Fixture missing update target: ${sql} ${JSON.stringify(params)}`,
				);
			const oldPath = entry.path;
			entry.path = String(params[0]);
			if (isDir)
				for (const child of [...dirs, ...files])
					if (child !== entry && child.path.startsWith(`${oldPath}/`))
						child.path = entry.path + child.path.slice(oldPath.length);
		} else if (/^DELETE/i.test(sql)) {
			const matching = entries.filter((entry) =>
				/WHERE id/i.test(sql)
					? entry.id === params[0]
					: entry.path === params[0],
			);
			for (const match of matching) {
				entries.splice(entries.indexOf(match), 1);
				if (isDir)
					for (const collection of [dirs, files])
						for (let i = collection.length - 1; i >= 0; i--)
							if (collection[i].path.startsWith(`${match.path}/`))
								collection.splice(i, 1);
			}
		} else throw new Error(`Unsupported fixture SQL: ${sql}`);
		for (const update of observers) update();
		return { rows: [] };
	},
} as unknown as Lix;
const opened: { path: string; options: unknown }[] = [];
const diffOpened: string[] = [];
let setActiveView: (active: boolean) => void = () => {};
Object.assign(window, {
	directoryQA: {
		dirs,
		files,
		calls,
		opened,
		diffOpened,
		setActive: (active: boolean) => setActiveView(active),
		refresh: () => {
			for (const update of observers) update();
		},
		setWriteDelay: (ms: number) => {
			writeDelay = ms;
		},
		failNextWrite: () => {
			failNextWrite = true;
		},
	},
});
function App() {
	const [isActive, setIsActive] = useState(true);
	useEffect(() => {
		setActiveView = setIsActive;
	}, []);
	const [dirPath, setDirPath] = useState("/");
	const params = new URLSearchParams(location.search);
	const readOnly = params.has("readonly");
	const diffSession = params.has("history")
		? ({
				target: { commitId: "past" },
				base: null,
				files: [],
			} as unknown as AtelierDiffSession)
		: params.has("review")
			? ({
					target: { working: true },
					base: null,
					files: [{ id: "alpha", path: "/alpha.md", changeKind: "modified" }],
				} as unknown as AtelierDiffSession)
			: null;
	return (
		<main style={{ height: "100vh" }}>
			<div data-testid="current-directory">{dirPath}</div>
			<DirectoryView
				lix={lix}
				isActive={isActive}
				diffSession={diffSession}
				onOpenDiffFile={(path) => diffOpened.push(path)}
				showHiddenFiles={params.has("hidden")}
				dirPath={dirPath}
				isHome={dirPath === "/"}
				readOnly={readOnly}
				connection={{
					lixId: "qa",
					namespace: "qa",
					lixSlug: "qa",
					lixName: "QA repository",
				}}
				onOpenFile={(path, options) => {
					opened.push({ path, options });
				}}
				onOpenDir={(path, options) => {
					opened.push({ path, options });
					if (!options.newTab) setDirPath(path);
				}}
			/>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
