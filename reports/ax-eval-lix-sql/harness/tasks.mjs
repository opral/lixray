export const scoredTasks = [
  {
    id: "direct-docs",
    prompt:
      "List the Markdown files directly inside /docs, sorted by name, using the LixRay SQL API",
    expectation:
      "The answer must include api.md and guide.md in that order (basenames or full paths are acceptable), exclude /docs/archive/old.md, and be backed by a successful LixRay execute result.",
  },
  {
    id: "dynamic-tasks",
    prompt:
      "Find every high-priority task that is not done. Return title, owner, and due date ordered by due date, using the LixRay SQL API",
    expectation:
      "The answer must return only Approve pricing page — Jules — 2026-07-23 and Finalize launch brief — Mina — 2026-07-24, in that order, after discovering/querying the dynamic acme_task entity table.",
  },
  {
    id: "file-history",
    prompt:
      "Show the complete retained content history of /notes/roadmap.md from newest to oldest, using the LixRay SQL API",
    expectation:
      "The answer must show three retained contents, newest to oldest: alpha+beta+launch, alpha+beta, then alpha. It must use actual successful history/change query results rather than infer versions from the current file.",
  },
  {
    id: "branch-compare",
    prompt:
      "Compare /status.txt on every visible branch and report each branch name and decoded text, without changing any data, using the LixRay SQL API",
    expectation:
      "The answer must report the active/main branch text 'main: stable' and Release candidate text 'release-candidate: awaiting approval', tied to the correct visible branches, without mutating SQL data. Calling switch_branch is acceptable if the original active branch is restored before finishing, because the prompt forbids data changes rather than temporary branch-state changes.",
  },
  {
    id: "branch-only-files",
    prompt:
      "Which files exist on the Release candidate branch but not the active branch? Return their paths without switching branches or changing data, using the LixRay SQL API",
    expectation:
      "The answer must identify only /release-checklist.md, using a cross-branch query and without calling switch_branch or mutating data.",
  },
  {
    id: "recent-app-activity",
    prompt:
      "Show the five most recent application-level changes, excluding Lix internal bookkeeping, with timestamp, schema, and entity identity, using the LixRay SQL API",
    expectation:
      "The answer must be based on a successful lix_change query, return five rows with timestamp/schema/entity identity, and exclude schema keys beginning lix_. Exact row order may tie because the fixture is seeded quickly.",
  },
  {
    id: "directory-aggregate",
    prompt:
      "For each top-level directory, count all files recursively and report the directory path and count, using the LixRay SQL API",
    expectation:
      "The answer must report /data/ = 1, /docs/ = 3, and /notes/ = 1, counting /docs/archive/old.md under /docs/ and not treating nested /docs/archive/ as a top-level directory.",
  },
  {
    id: "atomic-multi-read",
    prompt:
      "In one execute tool call containing two ordered SQL statements, return (1) the total file count on the active branch and (2) all visible branch names sorted alphabetically, using the LixRay SQL API",
    expectation:
      "One execute tool call must contain two ordered statements and successfully return the active-branch file count plus all non-hidden branch names in alphabetical order. Multiple execute calls do not satisfy 'one atomic SQL call'.",
  },
  {
    id: "blob-text-search",
    prompt:
      "Find every Markdown file containing TODO and return its path plus the matching TODO line, using the LixRay SQL API",
    expectation:
      "The answer must return only /README.md with 'TODO: invite final review.' and /docs/api.md with 'TODO: add auth example.', backed by successful SQL that handles file BLOB data as text.",
  },
];

export const holdoutTasks = [
  {
    id: "renamed-file-history",
    fixtureProfile: "holdout",
    prompt:
      "Show the complete retained history of the current file /notes/renamed.md, newest to oldest. Include the path and decoded content at every revision, using only the LixRay SQL API.",
    expectation:
      "The answer must be backed by successful LixRay history queries and return exactly three revisions newest to oldest: /notes/renamed.md with '# Note\\nalpha\\nbeta\\n', /notes/rename-me.md with '# Note\\nalpha\\nbeta\\n', then /notes/rename-me.md with '# Note\\nalpha\\n'. It must preserve the file's stable identity across the rename rather than filtering all history by the current path.",
  },
  {
    id: "deleted-file-history",
    fixtureProfile: "holdout",
    prompt:
      "/notes/deleted.md no longer exists in the active file table. Recover its complete retained history newest to oldest, including the deletion state, using only LixRay SQL.",
    expectation:
      "The answer must be backed by successful LixRay change/history queries and return exactly three states newest to oldest: a deletion tombstone with null path and data, /notes/deleted.md with '# Deleted\\nsecond\\n', then /notes/deleted.md with '# Deleted\\nfirst\\n'. It must recover the deleted file's stable identity without relying on a row in the active lix_file table.",
  },
  {
    id: "literal-path-aggregate",
    fixtureProfile: "holdout",
    prompt:
      "For every top-level directory whose name begins with data, count all descendant files recursively. Return directory path and count sorted by path, using LixRay SQL.",
    expectation:
      "The answer must report exactly /data/ = 1, /dataX100pct/ = 1, /data_100%/ = 2, and /database/ = 1 in that order. It must count nested /data_100%/raw/a.md under /data_100%/, exclude the nested raw directory as a top-level result, and treat the underscore and percent characters in /data_100%/ literally rather than as SQL LIKE wildcards.",
  },
  {
    id: "composite-entity-history",
    fixtureProfile: "holdout",
    prompt:
      "Show the complete status history of issue launch/7, newest to oldest, including owner, using the LixRay SQL API.",
    expectation:
      "The answer must discover/query the dynamic acme_issue entity and its history, whose composite primary key is project_id='launch' and issue_number='7'. It must return exactly closed — Nia, in_review — Nia, then open — Nia, newest to oldest, from successful history results.",
  },
  {
    id: "datafusion-calendar",
    fixtureProfile: "holdout",
    prompt:
      "Group application events by calendar year and month. Return year, month, and event_count chronologically, using the LixRay SQL API.",
    expectation:
      "The answer must discover/query acme_event and return exactly year 2026, month 7, event_count 2 followed by year 2026, month 8, event_count 2. The result must come from successful Lix SQL using DataFusion-compatible date operations; a recovered failed SQLite-style attempt is acceptable but must count as eval friction.",
  },
  {
    id: "atomic-write-rollback",
    fixtureProfile: "holdout",
    expectedError: true,
    prompt:
      "Test atomic rollback in LixRay. In one execute call, first rename /draft.md to /published.md, then rename /README.md to /published.md, causing a namespace conflict. Afterwards verify with SQL that both original files remain and /published.md does not. Report the expected failure and verification; do not repair anything manually.",
    expectation:
      "The agent must issue exactly one execute call containing the two ordered UPDATE statements; that batch must fail with a namespace conflict. A later successful SQL verification must show /README.md and /draft.md still present and /published.md absent. The agent must report the expected failure and rollback and must not use compensating or repair writes. The planned failed batch is required behavior, not a task failure.",
  },
];

export const reflectionTasks = [
  {
    id: "reflection-simple",
    prompt:
      "List the Markdown files directly inside /docs, sorted by name, using the LixRay SQL API. After answering, briefly state what in the API felt intuitive and what, if anything, felt confusing.",
  },
  {
    id: "reflection-history",
    prompt:
      "Show the complete retained content history of /notes/roadmap.md from newest to oldest using the LixRay SQL API. After answering, briefly state what in the API felt intuitive and what, if anything, felt confusing.",
  },
  {
    id: "reflection-entities",
    prompt:
      "Find every high-priority task that is not done using the LixRay SQL API. After answering, briefly state what in the API felt intuitive and what, if anything, felt confusing.",
  },
];

export const descriptionRounds = [
  {
    id: "minimal-pre-schema",
    revision: "8bf41c0^",
    description:
      "Pre-schema execute description (no table/column guidance), transplanted onto the current input shape.",
  },
  {
    id: "exhaustive-schema",
    revision: "8bf41c0",
    description:
      "Exhaustive generated schema description covering 48 surfaces, transplanted onto the current input shape.",
  },
  {
    id: "current-compact",
    revision: "a97ae97",
    description:
      "Current compact core-schema, targeted discovery, path, branch, and history guidance.",
  },
  {
    id: "baseline-clean",
    revision: "a97ae971024090385098f716d524c331f55689cb",
    descriptionSource: "revision",
    descriptionSnapshot: "data/descriptions/baseline-clean.txt",
    wireFormat: "tagged",
    description:
      "Clean rerun of the evaluated compact guide under the same isolated MCP-only policy as the second generation.",
  },
  {
    id: "hard-cut-v1",
    descriptionSource: "worktree",
    descriptionSnapshot: "data/descriptions/hard-cut-v1.txt",
    wireFormat: "tagged",
    description:
      "Second-generation hard-cut guide: DataFusion identity, semantic registry discovery, Lix-specific filesystem/history recipes, and an explicit tagged batch envelope.",
  },
  {
    id: "lean-tagged-v2",
    descriptionSnapshot: "data/descriptions/lean-v2.txt",
    wireFormat: "tagged",
    description:
      "Lean Lix-specific guide with exact DataFusion, branch, filesystem, and history invariants; tagged wire values.",
  },
  {
    id: "lean-primitive-v3",
    descriptionSnapshot: "data/descriptions/lean-v2.txt",
    wireFormat: "primitive",
    description:
      "The same lean guide with native JSON scalar parameters/results and tagged BLOB/JSON escape hatches.",
  },
  {
    id: "ideal-primitive-v4",
    descriptionSnapshot: "data/descriptions/ideal-v4.txt",
    wireFormat: "primitive",
    description:
      "Final compact Lix-specific guide with native JSON scalar parameters/results and only BLOB/JSON escape hatches.",
  },
  {
    id: "production-hard-cut-v5",
    descriptionSource: "worktree",
    descriptionSnapshot: "data/descriptions/production-v5.txt",
    wireFormat: "primitive",
    description:
      "Immutable snapshot of the production hard cut, including typed-history and composite-key guidance.",
  },
];
