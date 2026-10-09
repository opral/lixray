import {
	createLixError,
	type TransactionClient,
	type WireValue,
} from "./lix-service.ts";

export type CheckpointScope =
	| { type: "all" }
	| {
			type: "selected";
			selections: Array<{ relation: string; row_refs: string[] }>;
	  };
export interface CheckpointInput {
	title: string;
	description?: string;
	scope: CheckpointScope;
	expected_head_commit_id?: string;
}
export interface CheckpointReceipt {
	commit_id: string;
	baseline_commit_id: string;
	previous_head_commit_id: string;
	head_commit_id: string;
	conversation_id?: string;
	included_scope_complete: boolean;
	warning?: string;
	title: string;
	description?: string;
	scope: CheckpointScope;
	included_scope: Array<{ relation: string; row_refs: string[] }>;
}

export function validateCheckpoint(input: CheckpointInput) {
	if (!input.title?.trim() || /[\r\n]/.test(input.title))
		throw createLixError(
			"invalid_request",
			"Checkpoint title must be non-empty, one-line text.",
		);
	if (input.scope?.type !== "all" && input.scope?.type !== "selected")
		throw createLixError(
			"invalid_request",
			"Choose all or selected checkpoint scope.",
		);
	if (
		input.scope.type === "selected" &&
		(!input.scope.selections.length ||
			input.scope.selections.some(
				(s) =>
					!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s.relation) || !s.row_refs.length,
			))
	)
		throw createLixError(
			"invalid_request",
			"Selected scope needs relations and canonical row_refs from lix_diff.",
		);
}

export function descriptionDocument(description: string) {
	return {
		kind: "json" as const,
		value: {
			_type: "zettel_doc",
			blocks: description.split(/\r?\n/).map((text, index) => ({
				_type: "zettel_block",
				_key: `p${index}`,
				style: "normal",
				markDefs: [],
				children: [
					{ _type: "zettel_span", _key: `s${index}`, text, marks: [] },
				],
			})),
		},
	};
}
export function textCell(
	result: { columns: string[]; rows: WireValue[][] },
	column: string,
): string {
	const value = result.rows[0]?.[result.columns.indexOf(column)];
	if (value?.kind !== "text")
		throw createLixError("upstream_error", `Lix did not return ${column}.`);
	return value.value;
}

// Read identities only, never file bodies. Include every executable row relation,
// so receipts expose dependencies as well as the caller's selected roots.
export async function changedRows(
	tx: TransactionClient,
	before: string,
	after: string,
) {
	const catalog = await tx.execute({
		sql: "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'lixcol_change_id' ORDER BY table_name",
	});
	const selections: Array<{ relation: string; row_refs: string[] }> = [];
	for (const row of catalog.rows) {
		const value = row[0];
		if (value?.kind !== "text" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.value))
			throw createLixError(
				"upstream_error",
				"Invalid relation in Lix catalog.",
			);
		const relation = value.value;
		const diff = await tx.execute({
			sql: `SELECT CAST(row_ref AS TEXT) AS row_ref FROM lix_diff('${relation}', $1, $2)`,
			params: [
				{ kind: "text", value: before },
				{ kind: "text", value: after },
			],
		});
		const row_refs = diff.rows.map((row) => {
			if (row[0]?.kind !== "text")
				throw createLixError("upstream_error", "Invalid diff row reference.");
			return row[0].value;
		});
		if (row_refs.length) selections.push({ relation, row_refs });
	}
	return selections;
}

export async function checkpointInTransaction(
	tx: TransactionClient,
	input: CheckpointInput,
	affectedSpan?: { before: string; after: string },
): Promise<CheckpointReceipt> {
	validateCheckpoint(
		affectedSpan ? { ...input, scope: { type: "all" } } : input,
	);
	const state = await tx.execute({
		sql: "SELECT commit_id, working_base_commit_id FROM lix_branch WHERE id = lix_active_branch_id()",
	});
	const head = textCell(state, "commit_id");
	const baseline = textCell(state, "working_base_commit_id");
	if (input.expected_head_commit_id && head !== input.expected_head_commit_id)
		throw createLixError(
			"conflict",
			"Branch head changed before checkpoint creation.",
			{
				details: { current_commit_id: head },
				hint: "Review the new changes before creating a checkpoint.",
			},
		);
	const scope: CheckpointScope =
		affectedSpan && input.scope.type !== "all"
			? {
					type: "selected",
					selections: await changedRows(
						tx,
						affectedSpan.before,
						affectedSpan.after,
					),
				}
			: input.scope;
	const params: WireValue[] = [
		{ kind: "text", value: input.title.trim() },
		input.description === undefined
			? { kind: "null" }
			: descriptionDocument(input.description),
	];
	let selection = "";
	if (scope.type === "selected") {
		if (!scope.selections.length)
			throw createLixError(
				"invalid_request",
				"The batch has no tracked changes to checkpoint.",
			);
		const queries = scope.selections.map((s) => {
			const placeholders = [...new Set(s.row_refs)].map((ref) => {
				params.push({ kind: "text", value: ref });
				return `$${params.length}`;
			});
			return {
				sql: `SELECT row_ref FROM lix_diff('${s.relation}') WHERE row_ref IN (${placeholders.join(", ")})`,
				parameterCount: params.length,
			};
		});
		// A stale or unchanged identity must not silently disappear from the milestone.
		for (const [index, query] of queries.entries()) {
			const matched = await tx.execute({
				sql: query.sql,
				params: params.slice(0, query.parameterCount),
			});
			if (
				matched.rows.length !== new Set(scope.selections[index]!.row_refs).size
			)
				throw createLixError(
					"conflict",
					"Selected rows are no longer pending working changes.",
				);
		}
		selection = `, ARRAY(${queries.map((query) => query.sql).join(" UNION ALL ")})`;
	}
	const created = await tx.execute({
		sql: `SELECT commit_id FROM lix_create_checkpoint($1, $2${selection})`,
		params,
	});
	const commit_id = textCell(created, "commit_id");
	const conversation = await tx.execute({
		sql: "SELECT id FROM lix_conversation WHERE target = lix_row_ref('lix_commit', NULL, $1) AND lixcol_global = true",
		params: [{ kind: "text", value: commit_id }],
	});
	const conversationId = textCell(conversation, "id");
	let descriptionId: string | null = null;
	if (input.description !== undefined) {
		const opening = await tx.execute({
			sql: "SELECT id FROM lix_comment WHERE conversation_id = $1 AND lixcol_global = true",
			params: [{ kind: "text", value: conversationId }],
		});
		descriptionId = textCell(opening, "id");
	}
	await tx.execute({
		sql: "UPDATE lix_conversation SET lixcol_metadata = $1 WHERE id = $2 AND lixcol_global = true",
		params: [
			{
				kind: "json",
				value: { lixray_checkpoint: { description_comment_id: descriptionId } },
			},
			{ kind: "text", value: conversationId },
		],
	});

	return {
		commit_id,
		baseline_commit_id: baseline,
		previous_head_commit_id: head,
		head_commit_id: commit_id,
		title: input.title.trim(),
		...(input.description !== undefined
			? { description: input.description }
			: {}),
		scope,
		included_scope: [],
		included_scope_complete: false,
	};
}

/** Checkpoint membership becomes visible only after the engine commits. */
export async function completeCheckpointReceipt(
	tx: TransactionClient,
	receipt: CheckpointReceipt,
	actualHead: string,
) {
	const log = await tx.execute({
		sql: "SELECT conversation_id FROM lix_log($1) WHERE commit_id = $1 AND is_checkpoint",
		params: [{ kind: "text", value: receipt.commit_id }],
	});
	return {
		...receipt,
		head_commit_id: actualHead,
		conversation_id: textCell(log, "conversation_id"),
		included_scope: await changedRows(
			tx,
			receipt.baseline_commit_id,
			receipt.commit_id,
		),
		included_scope_complete: true,
	};
}

export async function updateCheckpointInTransaction(
	tx: TransactionClient,
	commitId: string,
	input: { title?: string; description?: string | null },
) {
	if (input.title !== undefined)
		validateCheckpoint({ title: input.title, scope: { type: "all" } });
	if (input.title === undefined && input.description === undefined)
		throw createLixError(
			"invalid_request",
			"Provide a title or description to correct.",
		);
	const log = await tx.execute({
		sql: "SELECT conversation_id FROM lix_log() WHERE commit_id = $1 AND is_checkpoint",
		params: [{ kind: "text", value: commitId }],
	});
	if (!log.rows.length)
		throw createLixError(
			"not_found",
			"Checkpoint not found on the context branch.",
		);
	const conversationId = textCell(log, "conversation_id");

	if (input.title !== undefined)
		await tx.execute({
			sql: "UPDATE lix_conversation SET title = $1 WHERE id = $2 AND lixcol_global = true",
			params: [
				{ kind: "text", value: input.title.trim() },
				{ kind: "text", value: conversationId },
			],
		});
	if (input.description !== undefined) {
		const conversation = await tx.execute({
			sql: "SELECT lixcol_metadata FROM lix_conversation WHERE id = $1 AND lixcol_global = true",
			params: [{ kind: "text", value: conversationId }],
		});
		const raw = conversation.rows[0]?.[0];
		const metadata =
			raw?.kind === "json" &&
			raw.value &&
			typeof raw.value === "object" &&
			!Array.isArray(raw.value)
				? (raw.value as Record<string, unknown>)
				: {};
		const checkpoint = metadata.lixray_checkpoint as
			| { description_comment_id?: string | null }
			| undefined;
		if (!checkpoint || !("description_comment_id" in checkpoint))
			throw createLixError(
				"invalid_request",
				"This checkpoint has no managed description pointer. Correct its conversation directly with execute_sql.",
			);
		const descriptionId = checkpoint.description_comment_id;
		if (descriptionId) {
			const changed = await tx.execute({
				sql: "UPDATE lix_comment SET body = $1 WHERE id = $2 AND conversation_id = $3 AND lixcol_global = true RETURNING id",
				params: [
					descriptionDocument(input.description ?? ""),
					{ kind: "text", value: descriptionId },
					{ kind: "text", value: conversationId },
				],
			});
			if (!changed.rows.length)
				throw createLixError(
					"not_found",
					"The checkpoint description comment was removed.",
				);
		} else if (input.description !== null) {
			const descriptionId = crypto.randomUUID();
			await tx.execute({
				sql: "INSERT INTO lix_comment (id, conversation_id, body, lixcol_global) VALUES ($1, $2, $3, true)",
				params: [
					{ kind: "text", value: descriptionId },
					{ kind: "text", value: conversationId },
					descriptionDocument(input.description),
				],
			});
			await tx.execute({
				sql: "UPDATE lix_conversation SET lixcol_metadata = $1 WHERE id = $2 AND lixcol_global = true",
				params: [
					{
						kind: "json",
						value: {
							...metadata,
							lixray_checkpoint: { description_comment_id: descriptionId },
						},
					},
					{ kind: "text", value: conversationId },
				],
			});
		}
	}
	return { commit_id: commitId, conversation_id: conversationId };
}
