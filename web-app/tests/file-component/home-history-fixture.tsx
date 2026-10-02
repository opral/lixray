import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lix } from "@lix-js/sdk";
import { useRepositoryControlPlaneData } from "../../src/components/repository-home/lix-data";

const localQueries: string[] = [];
const historyQueries: Array<{ branch: string; sql: string }> = [];
let branch = "a";
let acquisitions = 0;
let held = true;
let removeSource: () => void;
const renders: Array<{
	branch: string;
	hasSource: boolean;
	count: number | null | undefined;
}> = [];
const pending = new Set<() => void>();
function waitForChange(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			window.removeEventListener("home-history-change", finish);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		window.addEventListener("home-history-change", finish, { once: true });
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}
const local = {
	async *observe(
		sql: string,
		_params: unknown[],
		options: { signal: AbortSignal },
	) {
		localQueries.push(sql);
		if (sql.includes("lix_change") || sql.includes("lix_log(")) {
			throw Object.assign(
				new Error("A partial replica cannot inventory history"),
				{
					code: "LIX_PARTIAL_REPLICA_SCOPE_UNSUPPORTED",
				},
			);
		}
		while (!options.signal.aborted) {
			yield {
				result: {
					rows: sql.includes("lix_active_branch_id")
						? [{ id: branch }]
						: sql.includes("lix_diff(")
							? [{ file_count: 3 }]
							: [{ n: 2 }],
				},
			};
			await waitForChange(options.signal);
		}
	},
} as unknown as Lix;
const authority = async (): Promise<Lix> => {
	const selected = branch;
	acquisitions++;
	if (held) await new Promise<void>((resolve) => pending.add(resolve));
	return {
		async *observe(sql: string) {
			historyQueries.push({ branch: selected, sql });
			yield {
				result: {
					rows: sql.includes("lix_log(")
						? [
								{
									created_at: "2026-10-01",
									total_count: selected === "a" ? 7 : 9,
								},
							]
						: [
								{
									day: "2026-10-01",
									n: 4,
									total_count: selected === "a" ? 42 : 84,
									created_at: "2026-09-01",
								},
							],
				},
			};
		},
	} as unknown as Lix;
};
Object.assign(window, {
	homeHistoryQA: {
		renders,
		removeSource: () => removeSource(),
		hold: () => {
			held = true;
		},
		localQueries,
		historyQueries,
		acquisitions: () => acquisitions,
		release: () => {
			held = false;
			for (const resolve of pending) resolve();
			pending.clear();
		},
		switchBranch: () => {
			branch = "b";
			window.dispatchEvent(new Event("home-history-change"));
		},
	},
});
function App() {
	const [hasSource, setHasSource] = useState(
		!new URLSearchParams(location.search).has("no-source"),
	);
	useEffect(() => {
		removeSource = () => setHasSource(false);
	}, []);
	const source = hasSource ? authority : null;
	const data = useRepositoryControlPlaneData(local, source);
	renders.push({ branch, hasSource, count: data?.totalChangeCount });
	return <pre data-testid="summary">{JSON.stringify(data)}</pre>;
}
createRoot(document.getElementById("root")!).render(<App />);
