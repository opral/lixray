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

const defaultSql = "SELECT id, name, hidden, commit_id FROM lix_branch ORDER BY name, id";
const defaultParams = "[]";

export function SqlConsole({ organizationName }: { organizationName: string }) {
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
				if (current && response.branches.some((branch) => branch.id === current)) {
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
			<section className="page-heading">
				<p className="eyebrow">{organizationName}</p>
				<h1>SQL console</h1>
			</section>
			<div className="dashboard-grid">
				<aside className="panel">
					<div className="panel-header">
						<h2 className="panel-title">Branches</h2>
						<button
							className="button"
							type="button"
							onClick={() => void loadBranches()}
							disabled={loadingBranches}
							aria-label="Refresh branches"
							title="Refresh branches"
						>
							<RefreshCw size={15} aria-hidden="true" />
						</button>
					</div>
					<div className="panel-body">
						{loadingBranches && branches.length === 0 ? (
							<p className="status-line">Loading branches...</p>
						) : branches.length === 0 ? (
							<p className="status-line">No branches returned.</p>
						) : (
							<div className="branch-list" data-testid="branch-list">
								{branches.map((branch) => (
									<button
										key={branch.id}
										className="branch-button"
										type="button"
										data-active={branch.id === activeBranchId}
										data-testid="branch-button"
										aria-pressed={branch.id === activeBranchId}
										onClick={() => setActiveBranchId(branch.id)}
									>
										<span className="branch-name">{branch.name}</span>
										<span className="branch-meta">
											{branch.hidden ? "hidden" : "visible"}
										</span>
									</button>
								))}
							</div>
						)}
					</div>
				</aside>
				<section className="panel">
					<div className="panel-header">
						<h2 className="panel-title">SQL</h2>
						<span className="status-line">
							{activeBranch ? activeBranch.name : "No branch selected"}
						</span>
					</div>
					<div className="panel-body">
						<div className="editor-grid">
							<div className="field">
								<label htmlFor="sql">Statement</label>
								<textarea
									id="sql"
									className="textarea"
									value={sql}
									onChange={(event) => setSql(event.target.value)}
									spellCheck={false}
								/>
							</div>
							<div className="field">
								<label htmlFor="params">Params</label>
								<textarea
									id="params"
									className="textarea params"
									value={params}
									onChange={(event) => setParams(event.target.value)}
									spellCheck={false}
								/>
							</div>
						</div>
						<div className="toolbar">
							<span className="status-line">Params JSON</span>
							<button
								className="button primary"
								type="button"
								onClick={() => void executeSql()}
								disabled={executing || !activeBranchId}
							>
								<Play size={16} aria-hidden="true" />
								{executing ? "Executing" : "Execute"}
							</button>
						</div>
						{error ? (
							<div className="error-box" role="alert">
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
		<div className="result-shell" data-testid="query-result">
			<div className="result-meta">
				<span>
					<TableProperties size={14} aria-hidden="true" /> {result.rows.length} rows
				</span>
				<span>{result.rowsAffected} rows affected</span>
				<span>{result.notices.length} notices</span>
			</div>
			<div className="table-wrap">
				{result.columns.length === 0 ? (
					<div className="panel-body status-line">Statement completed.</div>
				) : (
					<table data-testid="result-table">
						<thead>
							<tr>
								{result.columns.map((column) => (
									<th key={column}>{column}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{result.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((value, columnIndex) => (
										<td className="code" key={columnIndex}>
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
