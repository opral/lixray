# MCP feedback triage — 2026-09-15

## Priorities

P0 means an immediate critical incident (for example, widespread data loss or a security compromise). P1 means a serious workflow or correctness failure that should be fixed next. The supplied evidence does not establish a P0.

| Priority | Finding | Action/status |
| --- | --- | --- |
| P1 | A successful write appeared to fail; agents could repeat an already committed mutation. | Fix the confirmed server UI delivery gap: ordinary receipt content, optional preview metadata, registered MCP Apps resource and tool linkage. Renderer failures keep the successful receipt and warning. The original connector's exact `Unexpected response type` still requires a retest there; a transport/host failure can still make receipt delivery uncertain. |
| P1 | File-tool and SQL instructions conflict; preview copy promises a visible card unconditionally. | Fixed server instructions, live/generated tool descriptions and docs. Prefer read_files/write_files for ordinary work; SQL for advanced reads, renames/deletes, directory and other mutations. Say preview support depends on the host. Full SQL reference moved out of server instructions into a readable resource; essential SQL rules remain on SQL tools. |
| Proposed enhancement | Guarding undo to a caller-specified commit is not supported. The current branch-wide undo API has no demonstrated correctness defect. | If shared-branch workflows require it, add an optional capability: accept a commit-based expected target and validate it in the same transaction that creates the inverse commit; reject mismatches without mutation. Keep commit IDs; no operation_id is needed. This is not a confirmed P1 bug. Arbitrary historical selective undo/conflict previews are a larger feature and need separate semantics. |
| P1 | Reversal guidance failed to steer the agent toward the existing undo operation. | Fixed guidance to prefer undo for the latest undoable change, inspect history if later edits may exist, and distinguish checkpoints/restore. Guidance alone does not solve concurrent changes. |
| P2 | Issue search/create/comment APIs are absent. | Add only after defining an actual issue model and authorization. Until then, reporting instructions should permit a local report when no reporting tool is available; do not invent issue tables or imply filing happened. The repository-specific instructions cited in the feedback were not supplied for inspection. |

## Corrections to the feedback

- Current Lix exposes undo and redo through SQL (`SELECT commit_id FROM lix_undo()` / `lix_redo()`); the JavaScript and Rust typed methods are removed. The MCP's context-only tools execute those statements and return their single `commit_id` receipt.
- Undo itself creates an inverse commit. A manual delete and undo differ in reversal semantics and redo behavior, not in whether they create a commit. Checkpoints form an undo boundary.
- Before this change, the full SQL guide was in server instructions and the two SQL tools carried focused SQL guides. Every tool did not repeat the full SDK guide; they do each carry shared privacy guidance. The correction retains essential self-contained tool instructions.
- A successful standard SDK parse does not prove the original host rendered the UI or accepted every content block. The exact host error was not reproduced locally.

## Implemented fix

`write_files` declares `_meta.ui.resourceUri = ui://lixray/write-preview/v1`.
`resources/read` returns a static, repository-independent HTML view. Per-write,
server-rendered cards travel in `_meta["lixray/write-preview"].cards`, outside
both content and structuredContent. Text receipts and file links are unchanged.
The view handles MCP Apps initialization, tool results, resize notifications,
link opening, cancellation and teardown. It performs no mutation calls.

The resource has no external network dependencies. The view mounts Atelier's
sanitized static cards in shadow roots, not executable document frames.
Preview path probing is now also inside the post-write preview error boundary.

## Validation

- 123 MCP tests passed, including write receipts and runtime transport tests.
- Official @modelcontextprotocol/ext-apps 2.0.0 AppBridge browser test passed: load resource, initialize, receive/render result, open link and teardown. It also checks script/network isolation, non-parent message rejection and receipt/error fallback.
- Real in-memory Lix from latest main: SDK v1 and v2 both successfully wrote the heading/list/table/checklist fixture, read back identical bytes via query_sql and loaded the advertised resource. The reproduction script generates local evidence in artifacts/mcp-ui-fix/.
- TypeScript and focused ESLint passed. Browser regression added to PR CI.

Source revisions used: lixray 3028f60abc6f2534ea00b31a16ddedcd3f61d77a;
atelier 5cffbfdc38dba2ad3632a758b09ba16803b79913;
lix 54c023f8f3c2e97a74caf89688513df8beeaa7a8.
Those revisions identify the initial validation; integration preserves existing dev work and incorporates newer main commits. No Atelier or Lix source code was changed. No production repository was written and nothing was deployed.

## Reproduce locally

After installing workspace dependencies and preparing the vendored SDK and Atelier:

```sh
node --experimental-strip-types web-app/scripts/reproduce-mcp-ui.mjs
pnpm --dir web-app test:mcp-ui
```

The first command uses fresh in-memory databases and writes local diagnostic
artifacts. It does not connect to the production demo repository.
