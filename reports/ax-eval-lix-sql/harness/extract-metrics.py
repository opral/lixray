#!/usr/bin/env python3
"""Extract deterministic ax-eval metrics from Codex JSONL run logs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from collections import Counter
from pathlib import Path


REPORT_ROOT = Path(__file__).resolve().parent.parent
RAW_SCORED_ROOT = REPORT_ROOT / "data" / "raw" / "scored"
RAW_HOLDOUT_ROOT = REPORT_ROOT / "data" / "raw" / "holdout"
JUDGE_SCORED_ROOT = REPORT_ROOT / "data" / "judges"
JUDGE_HOLDOUT_ROOT = REPORT_ROOT / "data" / "judges" / "holdout"
OUTPUT_JSON = REPORT_ROOT / "data" / "results.json"
OUTPUT_CSV = REPORT_ROOT / "data" / "results.csv"
RUN_INDEX_JSON = REPORT_ROOT / "data" / "raw" / "run-index.json"
MANUAL_AUDIT_JSON = REPORT_ROOT / "data" / "manual-audit.json"
KNOWN_ROUND_ORDER = [
    "minimal-pre-schema",
    "exhaustive-schema",
    "current-compact",
    "baseline-clean",
    "hard-cut-v1",
    "lean-tagged-v2",
    "lean-primitive-v3",
    "ideal-primitive-v4",
    "production-hard-cut-v5",
]
SCHEMA_PROBE_PATTERN = re.compile(
    r"information_schema|sqlite_schema|sqlite_master|show\s+(?:full\s+)?tables|pragma|lix_registered_schema",
    re.IGNORECASE,
)


def manual_overrides() -> dict[tuple[str, str], dict]:
    if not MANUAL_AUDIT_JSON.exists():
        return {}
    payload = json.loads(MANUAL_AUDIT_JSON.read_text())
    return {
        (item["round"], item["task_id"]): item
        for item in payload.get("overrides", [])
    }


MANUAL_OVERRIDES = manual_overrides()


def clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def score(duration_sec: float, tool_calls: int, interruptions: float, errors: int) -> dict[str, int]:
    friction = clamp(100 - interruptions * 14)
    speed = clamp(100 - ((duration_sec - 30) / 570) * 100)
    efficiency = clamp(100 - ((tool_calls - 1) / 39) * 100)
    error_recovery = clamp(100 - (errors / 15) * 100)
    final = (
        0.30 * friction
        + 0.25 * speed
        + 0.20 * efficiency
        + 0.25 * error_recovery
    )
    return {
        "friction": round(friction),
        "speed": round(speed),
        "efficiency": round(efficiency),
        "errorRecovery": round(error_recovery),
        "final": round(final),
    }


def quantile(values: list[float], q: float) -> float:
    """Linear interpolation at (n - 1) * q, matching common exploratory summaries."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("quantile of empty collection")
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def rounded(value: float) -> int | float:
    integer = round(value)
    return integer if math.isclose(value, integer) else round(value, 1)


def parse_events(path: Path) -> list[dict]:
    events = []
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        try:
            events.append(json.loads(raw))
        except json.JSONDecodeError:
            events.append({"type": "diagnostic", "text": raw})
    return events


def item_error(item: dict) -> bool:
    if item.get("status") == "failed" or item.get("error"):
        return True
    if item.get("type") == "command_execution":
        code = item.get("exit_code")
        return isinstance(code, int) and code != 0
    return False


def normalize_first_action(item: dict) -> str:
    if item.get("type") == "mcp_tool_call":
        return f"mcp:{item.get('tool', 'unknown')}"
    if item.get("type") == "web_search":
        return "web_search"
    return "shell"


def judgment_path(meta: dict) -> Path:
    root = JUDGE_HOLDOUT_ROOT if meta.get("kind") == "holdout" else JUDGE_SCORED_ROOT
    if meta.get("invocationId") and meta.get("repetition") is not None:
        repetition = f'repetition-{int(meta["repetition"]):03d}'
        return (
            root
            / meta["round"]
            / "invocations"
            / meta["invocationId"]
            / repetition
            / f'{meta["taskId"]}.json'
        )
    return root / meta["round"] / f'{meta["taskId"]}.json'


def read_run(
    meta_path: Path,
    judgment: dict | None = None,
    run_index_path: Path | None = None,
    judge_index_path: Path | None = None,
) -> dict:
    meta = json.loads(meta_path.read_text())
    log_path = meta_path.with_name(meta_path.name.removesuffix(".meta.json") + ".jsonl")
    events = parse_events(log_path)
    completed_items = [
        event["item"]
        for event in events
        if event.get("type") == "item.completed" and isinstance(event.get("item"), dict)
    ]
    tool_items = [
        item
        for item in completed_items
        if item.get("type") in {"mcp_tool_call", "command_execution", "web_search"}
    ]
    errors = [item for item in tool_items if item_error(item)]
    commands = [
        item.get("command", "")
        for item in tool_items
        if item.get("type") == "command_execution"
    ][:3]
    actions = [normalize_first_action(item) for item in tool_items][:3]
    final_messages = [
        item.get("text", "")
        for item in completed_items
        if item.get("type") == "agent_message"
    ]
    usage_events = [event.get("usage", {}) for event in events if event.get("type") == "turn.completed"]
    usage = usage_events[-1] if usage_events else {}
    judge_path = (
        REPORT_ROOT / judgment["artifactPaths"]["judgment"]
        if judgment and judgment.get("artifactPaths", {}).get("judgment")
        else judgment_path(meta)
    )
    if judgment is None:
        judgment = json.loads(judge_path.read_text()) if judge_path.exists() else None
    verdict = judgment["verdict"] if judgment else {
        "success": False,
        "reason": "Missing judgment.",
        "failure_mode": "tool_failure",
    }
    # Historical manual decisions apply only to the original singleton cell, not
    # to independent repetitions of the same task and round.
    override = (
        MANUAL_OVERRIDES.get((meta["round"], meta["taskId"]))
        if meta.get("invocationId") is None
        else None
    )
    audited_success = bool(override["success"]) if override else bool(verdict["success"])
    interruptions = 0
    run_scores = score(meta["durationSec"], len(tool_items), interruptions, len(errors))
    expected_errors = 1 if meta.get("expectedError") and errors else 0
    unexpected_errors = max(0, len(errors) - expected_errors)
    execute_calls = []
    schema_probe_statements = 0
    schema_rows_fetched = 0
    for item in tool_items:
        if item.get("type") != "mcp_tool_call" or item.get("tool") != "execute":
            continue
        statements = [
            statement
            for statement in (item.get("arguments") or {}).get("statements", [])
            if isinstance(statement, dict)
        ]
        structured = ((item.get("result") or {}).get("structured_content") or {})
        statement_results = structured.get("results", [])
        for index, statement in enumerate(statements):
            if not SCHEMA_PROBE_PATTERN.search(statement.get("sql", "")):
                continue
            schema_probe_statements += 1
            if index < len(statement_results):
                schema_rows_fetched += len(statement_results[index].get("rows", []))
        execute_calls.append(
            {
                "success": not item_error(item),
                "statements": [
                    statement.get("sql", "")
                    for statement in statements
                ],
            }
        )
    return {
        "run_id": meta.get("runId", f'{meta["round"]}__{meta["taskId"]}'),
        "invocation_id": meta.get("invocationId"),
        "repetition": meta.get("repetition"),
        "repetitions": meta.get("repetitions", 1),
        "kind": meta.get("kind", "scored"),
        "round": meta["round"],
        "task_id": meta["taskId"],
        "prompt": meta["prompt"],
        "expected_error": bool(meta.get("expectedError")),
        "success": audited_success,
        "judge_success": bool(verdict["success"]),
        "success_reason": override["reason"] if override else verdict["reason"],
        "failure_mode": override["failure_mode"] if override else verdict["failure_mode"],
        "manual_override": override is not None,
        "duration_sec": meta["durationSec"],
        "tool_calls": len(tool_items),
        "mcp_tool_calls": sum(item.get("type") == "mcp_tool_call" for item in tool_items),
        "shell_calls": sum(item.get("type") == "command_execution" for item in tool_items),
        "interruptions": interruptions,
        "errors": len(errors),
        "expected_errors": expected_errors,
        "unexpected_errors": unexpected_errors,
        "scores": run_scores,
        "first_3_commands": commands,
        "first_3_actions": actions,
        "execute_calls": execute_calls,
        "execute_tool_calls": len(execute_calls),
        "failed_execute_calls": sum(not call["success"] for call in execute_calls),
        "sql_statements_submitted": sum(len(call["statements"]) for call in execute_calls),
        "schema_probe_statements": schema_probe_statements,
        "schema_rows_fetched": schema_rows_fetched,
        "first_execute_failed": bool(execute_calls and not execute_calls[0]["success"]),
        "final_answer": final_messages[-1] if final_messages else "",
        "usage": {
            "input_tokens": usage.get("input_tokens"),
            "cached_input_tokens": usage.get("cached_input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "reasoning_output_tokens": usage.get("reasoning_output_tokens"),
        },
        "runtime": {
            "lix_sdk_entry": meta.get("lixSdkEntry"),
            "native_batch": bool(meta.get("nativeBatch")),
        },
        "source": str(log_path.relative_to(REPORT_ROOT)),
        "metadata_source": str(meta_path.relative_to(REPORT_ROOT)),
        "judgment_source": str(judge_path.relative_to(REPORT_ROOT)),
        "run_index_source": (
            str(run_index_path.relative_to(REPORT_ROOT))
            if run_index_path is not None
            else None
        ),
        "judge_index_source": (
            str(judge_index_path.relative_to(REPORT_ROOT))
            if judge_index_path is not None
            else None
        ),
    }


def summarize(round_id: str, runs: list[dict]) -> dict:
    selected = [run for run in runs if run["round"] == round_id]
    dimensions = ["friction", "speed", "efficiency", "errorRecovery", "final"]
    dimension_summary = {}
    for dimension in dimensions:
        values = [run["scores"][dimension] for run in selected]
        dimension_summary[dimension] = {
            "median": rounded(statistics.median(values)),
            "p25": rounded(quantile(values, 0.25)),
            "p75": rounded(quantile(values, 0.75)),
        }
    first_action_counts = Counter(
        run["first_3_actions"][0] if run["first_3_actions"] else "none"
        for run in selected
    )
    common_action, common_count = first_action_counts.most_common(1)[0]
    return {
        "round": round_id,
        "n": len(selected),
        "successes": sum(run["success"] for run in selected),
        "success_rate": round(sum(run["success"] for run in selected) / len(selected), 4),
        "median_duration_sec": rounded(statistics.median(run["duration_sec"] for run in selected)),
        "p25_duration_sec": rounded(quantile([run["duration_sec"] for run in selected], 0.25)),
        "p75_duration_sec": rounded(quantile([run["duration_sec"] for run in selected], 0.75)),
        "median_tool_calls": rounded(statistics.median(run["tool_calls"] for run in selected)),
        "total_tool_calls": sum(run["tool_calls"] for run in selected),
        "total_errors": sum(run["errors"] for run in selected),
        "runs_with_errors": sum(run["errors"] > 0 for run in selected),
        "expected_errors": sum(run["expected_errors"] for run in selected),
        "unexpected_errors": sum(run["unexpected_errors"] for run in selected),
        "runs_with_unexpected_errors": sum(
            run["unexpected_errors"] > 0 for run in selected
        ),
        "shell_calls": sum(run["shell_calls"] for run in selected),
        "execute_tool_calls": sum(run["execute_tool_calls"] for run in selected),
        "failed_execute_calls": sum(run["failed_execute_calls"] for run in selected),
        "sql_statements_submitted": sum(
            run["sql_statements_submitted"] for run in selected
        ),
        "first_execute_failed_runs": sum(run["first_execute_failed"] for run in selected),
        "schema_probe_statements": sum(
            run["schema_probe_statements"] for run in selected
        ),
        "schema_rows_fetched": sum(run["schema_rows_fetched"] for run in selected),
        "repeated_runs": sum(run["repetition"] is not None for run in selected),
        "invocations": len(
            {
                run["invocation_id"]
                for run in selected
                if run["invocation_id"] is not None
            }
        ),
        "median_input_tokens": optional_median(
            [
                run["usage"]["input_tokens"]
                for run in selected
                if run["usage"]["input_tokens"] is not None
            ]
        ),
        "median_cached_input_tokens": optional_median(
            [
                run["usage"]["cached_input_tokens"]
                for run in selected
                if run["usage"]["cached_input_tokens"] is not None
            ]
        ),
        "median_output_tokens": optional_median(
            [
                run["usage"]["output_tokens"]
                for run in selected
                if run["usage"]["output_tokens"] is not None
            ]
        ),
        "common_first_action": f"{common_action} ({common_count}/{len(selected)})",
        "scores": dimension_summary,
    }


def optional_median(values: list[int | float]) -> int | float | None:
    return rounded(statistics.median(values)) if values else None


def ordered_round_ids(runs: list[dict]) -> list[str]:
    present = {run["round"] for run in runs}
    known = [round_id for round_id in KNOWN_ROUND_ORDER if round_id in present]
    return known + sorted(present - set(KNOWN_ROUND_ORDER))


def task_round_metrics(selected: list[dict]) -> dict:
    return {
        "n": len(selected),
        "repeated_runs": sum(run["repetition"] is not None for run in selected),
        "invocations": len(
            {
                run["invocation_id"]
                for run in selected
                if run["invocation_id"] is not None
            }
        ),
        "success": all(run["success"] for run in selected),
        "successes": sum(run["success"] for run in selected),
        "success_rate": round(
            sum(run["success"] for run in selected) / len(selected), 4
        ),
        "duration_sec": rounded(
            statistics.median(run["duration_sec"] for run in selected)
        ),
        "p25_duration_sec": rounded(
            quantile([run["duration_sec"] for run in selected], 0.25)
        ),
        "p75_duration_sec": rounded(
            quantile([run["duration_sec"] for run in selected], 0.75)
        ),
        "tool_calls": rounded(
            statistics.median(run["tool_calls"] for run in selected)
        ),
        "errors": sum(run["errors"] for run in selected),
        "expected_errors": sum(run["expected_errors"] for run in selected),
        "unexpected_errors": sum(run["unexpected_errors"] for run in selected),
        "final_score": rounded(
            statistics.median(run["scores"]["final"] for run in selected)
        ),
    }


def task_aggregates(runs: list[dict], round_ids: list[str]) -> list[dict]:
    aggregates = []
    for round_id in round_ids:
        task_ids = sorted(
            {run["task_id"] for run in runs if run["round"] == round_id}
        )
        for task_id in task_ids:
            selected = [
                run
                for run in runs
                if run["round"] == round_id and run["task_id"] == task_id
            ]
            aggregates.append(
                {
                    "round": round_id,
                    "task_id": task_id,
                    **task_round_metrics(selected),
                }
            )
    return aggregates


def paired_deltas(runs: list[dict], round_ids: list[str]) -> list[dict]:
    task_ids = sorted({run["task_id"] for run in runs})
    rows = []
    for task_id in task_ids:
        row = {"task_id": task_id}
        for round_id in round_ids:
            selected = [
                run
                for run in runs
                if run["round"] == round_id and run["task_id"] == task_id
            ]
            if selected:
                row[round_id] = task_round_metrics(selected)
        rows.append(row)
    return rows


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Extract ax-eval metrics. Historical flat cells are always retained; "
            "repeated invocations must be selected with exact run/judge index pairs."
        )
    )
    parser.add_argument("--scored-run-index", action="append", default=[])
    parser.add_argument("--scored-judge-index", action="append", default=[])
    parser.add_argument("--holdout-run-index", action="append", default=[])
    parser.add_argument("--holdout-judge-index", action="append", default=[])
    args = parser.parse_args()
    for kind in ("scored", "holdout"):
        run_indexes = getattr(args, f"{kind}_run_index")
        judge_indexes = getattr(args, f"{kind}_judge_index")
        if len(run_indexes) != len(judge_indexes):
            parser.error(
                f"each --{kind}-run-index needs one matching "
                f"--{kind}-judge-index (received {len(run_indexes)} and "
                f"{len(judge_indexes)})"
            )
    return args


def exact_index_path(raw_path: str, label: str) -> Path:
    path = Path(raw_path).resolve()
    if ".latest." in path.name or path.name.endswith(".latest.json"):
        raise ValueError(
            f"{label} must be a unique invocation index, not a latest pointer: {path}"
        )
    if not path.is_file():
        raise FileNotFoundError(f"{label} does not exist: {path}")
    return path


def load_indexed_runs(
    run_index_raw: str, judge_index_raw: str, expected_kind: str
) -> tuple[list[dict], dict]:
    run_index_path = exact_index_path(run_index_raw, f"{expected_kind} run index")
    judge_index_path = exact_index_path(
        judge_index_raw, f"{expected_kind} judge index"
    )
    run_index = json.loads(run_index_path.read_text())
    judge_index = json.loads(judge_index_path.read_text())
    if (
        run_index.get("schema") != 2
        or run_index.get("kind") != expected_kind
        or not isinstance(run_index.get("runs"), list)
    ):
        raise ValueError(
            f"{run_index_path} is not a schema-2 {expected_kind} run index"
        )
    judge_schema = judge_index.get("schema")
    if (
        judge_schema not in (2, 3)
        or judge_index.get("kind") != expected_kind
        or not isinstance(judge_index.get("judgments"), list)
    ):
        raise ValueError(
            f"{judge_index_path} is not a supported {expected_kind} judge index"
        )
    if judge_index.get("sourceInvocationId") != run_index.get("invocationId"):
        raise ValueError(
            "run/judge index invocation mismatch: "
            f'{run_index.get("invocationId")} != '
            f'{judge_index.get("sourceInvocationId")}'
        )
    judge_invocation_id = judge_index.get("judgeInvocationId")
    if judge_schema == 3 and (
        not isinstance(judge_invocation_id, str) or not judge_invocation_id
    ):
        raise ValueError(
            f"{judge_index_path} has no schema-3 judgeInvocationId"
        )
    expected_source_run_index = str(run_index_path.relative_to(REPORT_ROOT))
    if judge_index.get("sourceRunIndex") != expected_source_run_index:
        raise ValueError(
            f"{judge_index_path} cites {judge_index.get('sourceRunIndex')!r}, "
            f"not the selected exact run index {expected_source_run_index!r}"
        )
    indexed_judgments = {
        judgment["runId"]: judgment for judgment in judge_index["judgments"]
    }
    if len(indexed_judgments) != len(judge_index["judgments"]):
        raise ValueError(f"{judge_index_path} contains duplicate run IDs")
    run_ids = [run["runId"] for run in run_index["runs"]]
    if len(run_ids) != len(set(run_ids)):
        raise ValueError(f"{run_index_path} contains duplicate run IDs")
    expected_keys = {
        (round_id, task_id, repetition)
        for round_id in run_index.get("roundIds", [])
        for task_id in run_index.get("taskIds", [])
        for repetition in range(1, int(run_index["repetitions"]) + 1)
    }
    actual_keys = {
        (run.get("round"), run.get("taskId"), run.get("repetition"))
        for run in run_index["runs"]
    }
    if actual_keys != expected_keys or len(run_ids) != len(expected_keys):
        missing = sorted(map(str, expected_keys - actual_keys))
        extra = sorted(map(str, actual_keys - expected_keys))
        raise ValueError(
            f"{run_index_path} has incomplete repetition coverage; "
            f"missing={missing or 'none'}, extra={extra or 'none'}"
        )
    if set(run_ids) != set(indexed_judgments):
        missing = sorted(set(run_ids) - set(indexed_judgments))
        extra = sorted(set(indexed_judgments) - set(run_ids))
        raise ValueError(
            "run/judge index coverage mismatch; "
            f"missing judgments={missing or 'none'}, extra judgments={extra or 'none'}"
        )
    runs = []
    for indexed_run in run_index["runs"]:
        meta_relative_path = indexed_run.get("artifactPaths", {}).get("meta")
        if not meta_relative_path:
            raise ValueError(
                f'run {indexed_run["runId"]} has no artifactPaths.meta'
            )
        meta_path = REPORT_ROOT / meta_relative_path
        meta = json.loads(meta_path.read_text())
        if (
            meta.get("runId") != indexed_run["runId"]
            or meta.get("invocationId") != run_index["invocationId"]
        ):
            raise ValueError(
                f"metadata identity mismatch for {indexed_run['runId']}: {meta_path}"
            )
        indexed_judgment = indexed_judgments[indexed_run["runId"]]
        indexed_source_invocation = (
            indexed_judgment.get("sourceInvocationId")
            or indexed_judgment.get("invocationId")
        )
        if indexed_source_invocation != run_index["invocationId"]:
            raise ValueError(
                f"judgment source invocation mismatch for "
                f"{indexed_run['runId']}: {indexed_source_invocation!r}"
            )
        if (
            judge_schema == 3
            and indexed_judgment.get("judgeInvocationId")
            != judge_invocation_id
        ):
            raise ValueError(
                f"judgment invocation mismatch for {indexed_run['runId']}"
            )
        judgment_relative_path = indexed_judgment.get("artifactPaths", {}).get(
            "judgment"
        )
        if not judgment_relative_path:
            raise ValueError(
                f'judgment {indexed_run["runId"]} has no artifactPaths.judgment'
            )
        judgment_path = REPORT_ROOT / judgment_relative_path
        judgment = json.loads(judgment_path.read_text())
        if judgment.get("runId") != indexed_run["runId"]:
            raise ValueError(
                f"judgment identity mismatch for {indexed_run['runId']}: "
                f"{judgment_path}"
            )
        judgment_source_invocation = (
            judgment.get("sourceInvocationId") or judgment.get("invocationId")
        )
        if judgment_source_invocation != run_index["invocationId"]:
            raise ValueError(
                f"on-disk judgment source invocation mismatch for "
                f"{indexed_run['runId']}: {judgment_path}"
            )
        if (
            judge_schema == 3
            and judgment.get("judgeInvocationId") != judge_invocation_id
        ):
            raise ValueError(
                f"on-disk judgment invocation mismatch for "
                f"{indexed_run['runId']}: {judgment_path}"
            )
        # Preserve the artifact path recorded by the exact judge manifest.
        judgment["artifactPaths"] = indexed_judgment["artifactPaths"]
        runs.append(
            read_run(
                meta_path,
                judgment=judgment,
                run_index_path=run_index_path,
                judge_index_path=judge_index_path,
            )
        )
    source = {
        "kind": expected_kind,
        "invocation_id": run_index["invocationId"],
        "judge_invocation_id": judge_invocation_id,
        "repetitions": run_index["repetitions"],
        "run_index": str(run_index_path.relative_to(REPORT_ROOT)),
        "judge_index": str(judge_index_path.relative_to(REPORT_ROOT)),
        "runs": len(runs),
    }
    return runs, source


def legacy_meta_paths(root: Path) -> list[Path]:
    # Intentionally one directory deep. Nested invocation artifacts must only
    # enter an aggregate through an exact run/judge index pair.
    return sorted(root.glob("*/*.meta.json"))


def main() -> None:
    args = parse_arguments()
    runs = [
        read_run(meta_path)
        for meta_path in legacy_meta_paths(RAW_SCORED_ROOT)
    ]
    holdout_runs = [
        read_run(meta_path)
        for meta_path in legacy_meta_paths(RAW_HOLDOUT_ROOT)
    ]
    selected_sources = []
    selected_meta_paths = []
    for run_index, judge_index in zip(
        args.scored_run_index, args.scored_judge_index
    ):
        indexed_runs, source = load_indexed_runs(
            run_index, judge_index, "scored"
        )
        runs.extend(indexed_runs)
        selected_sources.append(source)
        selected_meta_paths.extend(
            REPORT_ROOT / run["metadata_source"]
            for run in indexed_runs
        )
    for run_index, judge_index in zip(
        args.holdout_run_index, args.holdout_judge_index
    ):
        indexed_runs, source = load_indexed_runs(
            run_index, judge_index, "holdout"
        )
        holdout_runs.extend(indexed_runs)
        selected_sources.append(source)
        selected_meta_paths.extend(
            REPORT_ROOT / run["metadata_source"]
            for run in indexed_runs
        )
    for selected_runs, kind in ((runs, "scored"), (holdout_runs, "holdout")):
        run_ids = [run["run_id"] for run in selected_runs]
        if len(run_ids) != len(set(run_ids)):
            raise ValueError(
                f"duplicate {kind} run IDs selected; pass each exact index only once"
            )
    round_ids = ordered_round_ids(runs)
    holdout_round_ids = ordered_round_ids(holdout_runs)
    round_positions = {round_id: index for index, round_id in enumerate(round_ids)}
    holdout_round_positions = {
        round_id: index for index, round_id in enumerate(holdout_round_ids)
    }
    runs.sort(
        key=lambda run: (
            round_positions[run["round"]],
            run["task_id"],
            run["invocation_id"] or "",
            run["repetition"] or 0,
        )
    )
    holdout_runs.sort(
        key=lambda run: (
            holdout_round_positions[run["round"]],
            run["task_id"],
            run["invocation_id"] or "",
            run["repetition"] or 0,
        )
    )
    payload = {
        "schema": 1,
        "method": {
            "metric_formulas": "ax-eval 4",
            "duration": "external wall clock around codex exec",
            "tool_calls": "completed shell, MCP, and web-search tool invocations",
            "errors": "failed shell/MCP invocations, including recovered errors",
            "interruptions": "zero; all runs were non-interactive",
            "success": "separate same-model judge session over full JSONL plus fixture-grounded criteria, followed by manual transcript audit overrides",
            "quantiles": "linear interpolation at (n-1)*q",
            "repetitions": "nested invocation artifacts are included only through explicit unique run/judge index pairs",
        },
        "sources": selected_sources,
        "rounds": [summarize(round_id, runs) for round_id in round_ids],
        "task_aggregates": task_aggregates(runs, round_ids),
        "paired_tasks": paired_deltas(runs, round_ids),
        "runs": runs,
        "holdouts": {
            "rounds": [
                summarize(round_id, holdout_runs)
                for round_id in holdout_round_ids
            ],
            "task_aggregates": task_aggregates(
                holdout_runs, holdout_round_ids
            ),
            "runs": holdout_runs,
        },
    }
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps(payload, indent=2) + "\n")

    all_metadata = []
    indexed_meta_paths = {
        path.resolve()
        for path in [
            *legacy_meta_paths(RAW_SCORED_ROOT),
            *legacy_meta_paths(RAW_HOLDOUT_ROOT),
            *sorted((REPORT_ROOT / "data" / "raw" / "reflection").glob("*/*.meta.json")),
            *selected_meta_paths,
        ]
    }
    for meta_path in sorted(indexed_meta_paths):
        metadata = json.loads(meta_path.read_text())
        metadata["metaPath"] = str(meta_path.relative_to(REPORT_ROOT))
        all_metadata.append(metadata)
    RUN_INDEX_JSON.write_text(
        json.dumps(
            {
                "schema": 1,
                "totalRuns": len(all_metadata),
                "scoredRuns": sum(item.get("kind") == "scored" for item in all_metadata),
                "holdoutRuns": sum(
                    item.get("kind") == "holdout" for item in all_metadata
                ),
                "reflectionRuns": sum(
                    item.get("kind") == "reflection" for item in all_metadata
                ),
                "repeatedRuns": sum(
                    item.get("repetition") is not None for item in all_metadata
                ),
                "sources": selected_sources,
                "runs": all_metadata,
            },
            indent=2,
        )
        + "\n"
    )

    with OUTPUT_CSV.open("w", newline="") as handle:
        fieldnames = [
            "run_id",
            "invocation_id",
            "repetition",
            "round",
            "task_id",
            "success",
            "failure_mode",
            "duration_sec",
            "tool_calls",
            "mcp_tool_calls",
            "shell_calls",
            "errors",
            "expected_errors",
            "unexpected_errors",
            "execute_tool_calls",
            "failed_execute_calls",
            "sql_statements_submitted",
            "schema_probe_statements",
            "schema_rows_fetched",
            "first_execute_failed",
            "friction",
            "speed",
            "efficiency",
            "errorRecovery",
            "final",
        ]
        writer = csv.DictWriter(
            handle,
            fieldnames=fieldnames,
            lineterminator="\n",
        )
        writer.writeheader()
        for run in runs:
            writer.writerow(
                {
                    **{key: run[key] for key in fieldnames if key in run},
                    **run["scores"],
                }
            )


if __name__ == "__main__":
    main()
