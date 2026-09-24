# Agent trials: described checkpoints

Date: 2026-09-24. Tested upstream Lix `main` and LixRay `main` before changes.
Twelve independent GPT-6 Luna agents received the same goal: leave a checkpoint
whose change, reason, and caveat can be understood by a later agent. They did
not see other agents' results or competing candidate briefs. Three agents used
the existing API; three agents each received one of three candidate briefs.
Candidate trials assessed call construction and retrieval. Some also probed the
hosted MCP, which still ran a Lix version before the new comment relations.
These are usability observations, not a statistical estimate of user behavior.

| Surface | Agents | Result |
| --- | ---: | --- |
| Existing JS SDK | 2 | Both found `lix_create_checkpoint()` then global `lix_conversation` and Zettel `lix_comment` only after traversing checkpoint and conversation docs. Both stopped a fresh native build after about 90 seconds, so the SQL path was not run. |
| Existing hosted MCP | 1 | Created a document change and checkpoint on an isolated test branch. Comment insertion failed `LIX_UNSUPPORTED_SQL: unknown SQL table 'lix_conversation'`; the batch was not committed. The tool catalog and SQL resource did not disclose Zettel. Tracked as [LixRay #492](https://github.com/opral/lixray/issues/492). |
| Checkpoint accepts plain `description` | 3 | All three drafted the intended one-call SDK/MCP write. They still wanted a specified note-read query, a stable return field, and a way to retry if the note write fails after checkpoint creation. |
| Separate `addComment` call | 3 | Agents drafted two calls but flagged an unannotated checkpoint between them, ambiguous retries, and no retrieval contract. One live probe confirmed hosted MCP has no `add_comment` tool. |
| Raw SQL conversation and Zettel comment | 3 | Agents needed chained IDs, global scope flags, and Zettel grammar; one guessed an SDK entrypoint that does not exist. Live MCP probes were blocked by the old deployed catalog. |

The selected API takes a required plain-text `description` when a checkpoint is
created. The SDK returns `commitId`; MCP returns `commit_id`. A global
conversation/comment links the note to that commit. The note uses the commit ID
as its opening conversation and comment IDs, so `describeCheckpoint` /
`describe_checkpoint` can retry without duplicating it. If the note fails after
the checkpoint exists, the error includes its commit ID; an `execute_sql` batch
returns that ID with a warning because the batch already succeeded. The read
query and minimal Zettel shape are documented. `lix_comment.body` points to the
full schema for callers who need richer comments.

The hosted MCP observation reflects its deployment on the trial date. The local
implementation was verified against the newer in-memory Lix engine with
`node --experimental-strip-types web-app/scripts/verify-checkpoint-mcp.mjs`:
standalone checkpoint descriptions, `execute_sql` batch descriptions, retrieval,
schema-link discovery through `information_schema.columns`, and a retry that
corrected the one existing comment all passed. The hosted endpoint needs a newer Lix server
image before that behavior is available there. Candidate ratings and the hosted
failure are kept separate when interpreting these results.
