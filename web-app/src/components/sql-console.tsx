import { Play, RefreshCw, TableProperties } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type Branch,
	type ExecuteResponse,
	formatWireValue,
	parseParamsJson,
	useLixrayApi,
} from "~/lib/lixray-api";
import { formatCaughtError } from "~/lib/format";

const defaultSql =
	"SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id";
const defaultParams = "[]";
const buttonClass =
	"inline-flex min-h-[38px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-border-panel bg-bg-panel px-3.5 font-[680] text-text-secondary no-underline disabled:cursor-not-allowed disabled:opacity-[0.55]";
const panelClass =
	"rounded-[8px] border border-border-panel bg-bg-panel shadow-md";
const panelHeaderClass =
	"flex items-center justify-between gap-3 border-b border-border-subtle px-[18px] py-4";
const panelTitleClass = "m-0 text-[15px] font-[720] tracking-normal";
const panelBodyClass = "p-[18px]";
const fieldClass =
	"grid gap-2 [&_label]:text-[13px] [&_label]:font-[680] [&_label]:text-text-secondary";
const textareaClass =
	"w-full resize-y rounded-[7px] border border-border-panel bg-bg-panel p-3 font-mono text-[13px] leading-[1.55] text-text-primary outline-none focus:border-border-panel focus:outline-2 focus:outline-offset-1 focus:outline-ring-focus-visible";
const statusClass = "text-sm text-text-tertiary";
const errorClass =
	"mt-3.5 whitespace-pre-wrap rounded-[8px] border border-error-200 bg-error-50 px-3.5 py-3 text-error-800";

export function SqlConsole({ workspaceName }: { workspaceName: string }) {
	const api = useLixrayApi();
	const [branches, setBranches] = useState<Array<Branch>>([]);
	const [activeBranchId, setActiveBranchId] = useState("");
	const [sql, setSql] = useState(defaultSql);
	const [params, setParams] = useState(defaultParams);
	const [result, setResult] = useState<ExecuteResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingBranches, setLoadingBranches] = useState(false);
	const [executing, setExecuting] = useState(false);

	const activeBranch = useMemo(
		() => branches.find((branch) => branch.id === activeBranchId) ?? null,
		[branches, activeBranchId],
	);

	const loadBranches = useCallback(async () => {
		setLoadingBranches(true);
		setError(null);
		try {
			const response = await api.listBranches();
			setBranches(response.branches);
			setActiveBranchId((current) => {
				if (
					current &&
					response.branches.some((branch) => branch.id === current)
				) {
					return current;
				}
				return (
					response.branches.find((branch) => branch.name === "main")?.id ??
					response.branches[0]?.id ??
					""
				);
			});
		} catch (caught) {
			setError(formatCaughtError(caught));
		} finally {
			setLoadingBranches(false);
		}
	}, [api]);

	useEffect(() => {
		void loadBranches();
	}, [loadBranches]);

	const executeSql = async () => {
		setExecuting(true);
		setError(null);
		setResult(null);
		try {
			if (!activeBranchId) {
				throw new Error("Select a branch before executing SQL.");
			}
			const parsedParams = parseParamsJson(params);
			const response = await api.execute({
				branchId: activeBranchId,
				sql,
				params: parsedParams,
			});
			setResult(response);
		} catch (caught) {
			setError(formatCaughtError(caught));
		} finally {
			setExecuting(false);
		}
	};

	return (
		<>
			<section className="mb-[18px] max-w-[760px]">
				<p className="mb-2 text-[13px] font-[760] tracking-[0.08em] text-text-link uppercase">
					{workspaceName}
				</p>
				<h1 className="m-0 text-2xl leading-[1.2] tracking-normal">
					SQL console
				</h1>
			</section>
			<div className="grid grid-cols-[minmax(220px,290px)_minmax(0,1fr)] items-start gap-5 max-[800px]:grid-cols-1">
				<aside className={panelClass}>
					<div className={panelHeaderClass}>
						<h2 className={panelTitleClass}>Branches</h2>
						<button
							className={buttonClass}
							type="button"
							onClick={() => void loadBranches()}
							disabled={loadingBranches}
							aria-label="Refresh branches"
							title="Refresh branches"
						>
							<RefreshCw size={15} aria-hidden="true" />
						</button>
					</div>
					<div className={panelBodyClass}>
						{loadingBranches && branches.length === 0 ? (
							<p className={statusClass}>Loading branches...</p>
						) : branches.length === 0 ? (
							<p className={statusClass}>No branches returned.</p>
						) : (
							<div className="flex flex-col gap-2" data-testid="branch-list">
								{branches.map((branch) => (
									<button
										key={branch.id}
										className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-[7px] border border-border-panel bg-bg-panel px-[11px] py-2.5 text-left text-text-primary data-[active=true]:border-border-selection-current data-[active=true]:bg-bg-selection-current data-[active=true]:text-text-primary"
										type="button"
										data-active={branch.id === activeBranchId}
										data-testid="branch-button"
										aria-pressed={branch.id === activeBranchId}
										onClick={() => setActiveBranchId(branch.id)}
									>
										<span className="truncate">{branch.name}</span>
										<span className="shrink-0 text-xs text-text-tertiary">
											{branch.hidden ? "hidden" : "visible"}
										</span>
									</button>
								))}
							</div>
						)}
					</div>
				</aside>
				<section className={panelClass}>
					<div className={panelHeaderClass}>
						<h2 className={panelTitleClass}>SQL</h2>
						<span className={statusClass}>
							{activeBranch ? activeBranch.name : "No branch selected"}
						</span>
					</div>
					<div className={panelBodyClass}>
						<div className="grid grid-cols-[minmax(0,1fr)] gap-3">
							<div className={fieldClass}>
								<label htmlFor="sql">Statement</label>
								<textarea
									id="sql"
									className={`${textareaClass} min-h-[170px]`}
									value={sql}
									onChange={(event) => setSql(event.target.value)}
									spellCheck={false}
								/>
							</div>
							<div className={fieldClass}>
								<label htmlFor="params">Params</label>
								<textarea
									id="params"
									className={`${textareaClass} min-h-[92px]`}
									value={params}
									onChange={(event) => setParams(event.target.value)}
									spellCheck={false}
								/>
							</div>
						</div>
						<div className="mt-3 flex items-center justify-between gap-3 max-[800px]:flex-col max-[800px]:items-stretch">
							<span className={statusClass}>Params JSON</span>
							<button
								className={`${buttonClass} border-bg-action-primary bg-bg-action-primary text-text-on-action-primary max-[800px]:w-full`}
								type="button"
								onClick={() => void executeSql()}
								disabled={executing || !activeBranchId}
							>
								<Play size={16} aria-hidden="true" />
								{executing ? "Executing" : "Execute"}
							</button>
						</div>
						{error ? (
							<div className={errorClass} role="alert">
								{error}
							</div>
						) : null}
						{result ? <ResultTable result={result} /> : null}
					</div>
				</section>
			</div>
		</>
	);
}

function ResultTable({ result }: { result: ExecuteResponse }) {
	return (
		<div
			className="mt-[18px] overflow-hidden rounded-[8px] border border-border-panel bg-bg-panel"
			data-testid="query-result"
		>
			<div className="flex flex-wrap gap-3 border-b border-border-subtle px-3.5 py-3 text-[13px] text-text-tertiary">
				<span className="inline-flex items-center gap-1.5">
					<TableProperties size={14} aria-hidden="true" /> {result.rows.length}{" "}
					rows
				</span>
				<span>{result.rowsAffected} rows affected</span>
				<span>{result.notices.length} notices</span>
			</div>
			<div className="max-h-[380px] overflow-auto">
				{result.columns.length === 0 ? (
					<div className="p-[18px] text-sm text-text-tertiary">
						Statement completed.
					</div>
				) : (
					<table
						className="w-full border-collapse text-[13px]"
						data-testid="result-table"
					>
						<thead>
							<tr>
								{result.columns.map((column) => (
									<th
										className="sticky top-0 border-b border-border-subtle bg-bg-panel-muted px-3 py-2.5 text-left align-top font-[720] text-text-secondary"
										key={column}
									>
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{result.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((value, columnIndex) => (
										<td
											className="border-b border-border-subtle px-3 py-2.5 text-left align-top font-mono text-xs"
											key={columnIndex}
										>
											{formatWireValue(value)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
