# Public release review

Keep the repository private until the owner has resolved the findings from the
release audit and completed the external steps below. Merging a cleanup PR does
not erase earlier commits or GitHub-hosted records.

## Readiness update — October 12, 2026

PR [#609](https://github.com/opral/lixray/pull/609) adds an MIT license, a concise
README, contributor/operations docs, and explicit self-hosting scope. It removes
70 temporary plans, handoffs, experiment prototypes, and captured reports from
the current tree. Historical versions remain in Git; this is not a history rewrite.

The issue review closed 19 reports whose fixes are in merged Lix/LixRay code and
retained unresolved reports. Control-plane self-hosting demand is tracked in
[#610](https://github.com/opral/lixray/issues/610), without a delivery commitment.

A fresh GitHub settings read still shows default Actions token permissions set
to **write**, Actions permitted to approve pull requests, only `CI` required on
`main`, zero required approving reviews, and no `production` environment protection
or branch restrictions. The external release steps below remain outstanding.
Repository visibility is still private. The following audit is historical evidence,
not a certification of commits, logs, artifacts, or credentials added since September 22.

## Review scope

The 2026-09-22 review starts from `9cc2ccc` on `main`. It separates tracked source,
Git history, and GitHub issues/PRs because each needs a different removal process.
The `vendor/lix` and `vendor/atelier` gitlinks point to separate public repositories;
their complete histories need independent audits.

Three GPT-5.6 Luna reviewers at extra-high reasoning reviewed the current tree,
history, and GitHub surfaces separately. The current-tree review covered 559
tracked paths and 14 PNG assets. History scans covered 1,402 commits on 33 local
refs and 1,821 commits through 392 retained PR heads plus one PR merge ref: 1,828
distinct commits in total. These are snapshots, not a guarantee about later pushes.

Gitleaks 8.30.1 reported 20 local-history matches and 22 PR-history matches;
TruffleHog 3.97.5 reported six and seven respectively, with credential verification
disabled. Review classified these as fixtures, shell examples, public verification
or browser configuration, and infrastructure identifiers. No credential was
confirmed. Historical Supabase/Clerk configuration still needs owner confirmation
of its intended public scope; discovered values were not tried against services.
Commit-message and historical PNG/JPG pattern scans found no credential-pattern
matches. Binary pattern scanning is not a complete visual/privacy review.

Secret scanners detect patterns, not every kind of sensitive information. Test
fixtures, public browser configuration, and ordinary bug reports are not proof of
a credential leak. Credential validity must be established by the owner, without
trying discovered values against live services.

## GitHub record review

The text review covered 62 issues, 392 PRs, 706 thread comments, 24 reviews, and 30
inline review comments, across open and closed records. No high-confidence
credential was identified in those texts. Potential internal-reference redactions
for owner evaluation are [PR 211](https://github.com/opral/lixray/pull/211),
[PR 247](https://github.com/opral/lixray/pull/247) (developer-account references),
and [issue 254](https://github.com/opral/lixray/issues/254) (an internal address).
The values are intentionally not repeated here. Contact addresses and localhost
test examples were distinguished from credential disclosures.

The ten open issues are bug/performance reports: 425, 428, 431, 433, 434, 435, 436,
438, 445, and 454. Ordinary criticism and unresolved defects were retained. No
issue, PR, comment, log, or artifact was deleted by this PR. Closing an issue would
not make its contents private, and a source cleanup PR does not redact old PR
diffs. Assess sensitive contents individually rather than deleting all reports
that mention failure.

At collection time there were no releases or release assets, no forks, and
discussions were disabled. Wiki retrieval returned 404, so wiki content is not
certified by this audit. Actions metadata covered 6,272 runs and 1,551 artifacts
(899 active, 652 expired). Retained log/build-artifact content review is tracked
separately from this metadata inventory; unavailable/expired content cannot be
certified by a text scan.

## Changes reviewable in this PR

- Remove production inventory/qualification tooling under `evidence/` and the
  internal `INVESTIGATION.md`, `IMPLEMENTATION.md`, and
  `PRODUCTION-CUTOVER-42.md` reports. They contain operational snapshots, storage
  identifiers, and production cohort details; they are not needed by runtime CI.
- Anonymize workspace and telemetry references in the runtime-recovery postmortem.
  Remove production usage counts and internal analytics identifiers from the
  telemetry catalog while preserving its event definitions and migration mapping.
  Keep generic architecture, privacy documentation, and technical incident lessons.
- Ignore private evidence/scanner output and both historical Supabase CLI metadata
  locations to prevent accidental recommits.
- Add a checksum-pinned Gitleaks job with fully redacted output. Pull requests and
  pushes to `main` scan their commit range; manual runs scan all fetched refs.
  The scanner uses fixed default rules and a bare mirror so PR-authored config,
  fingerprint ignore files, and inline allow comments cannot suppress findings.
  Submodule contents are not part of this scan. Historical findings must be
  resolved separately rather than hidden in a blanket baseline.
- Block fork PRs from image publishing, preview credentials, and preview cleanup.
  Cleanup uses scripts from `main`. A fork that requires integration remains
  blocked by the required `CI` check until reviewed changes run on a repository
  branch; adding a preview label cannot bypass this boundary.
- Provide a private security-reporting contact in `SECURITY.md`.

Workflow conditions are defense in depth. A PR can change workflow files, so
GitHub's fork restrictions, review requirements, and the secret provider's OIDC
claims must enforce the actual credential boundary. Review imported fork changes,
including workflows and build scripts, before running them on a repository branch.

## History-removal rehearsal

A disposable, disconnected mirror was rewritten with `git-filter-repo` 2.47.0.
No live branch was rewritten or force-pushed. The rehearsal removed all historical
versions of `evidence/`, the three internal reports above,
`database/supabase/.temp/`, `supabase/.temp/`, `.env.development`, and
`.env.production`. It also replaced four exact incident references and applied
the reviewed postmortem/telemetry sanitization to historical document versions.
The Supabase CLI files contained linked-project and pooler connection metadata;
they are already absent from the current tree.

Validation inspected all reachable objects: 1,828 commits, 6,729 trees, and 5,836
blobs. No selected incident reference remained, the removed paths had no remaining
history, and both historical telemetry-catalog versions were sanitized. At the
reviewed `main` snapshot only the 20 intended documentation/evidence paths changed;
application source and submodule pins were identical. A subsequent raw Gitleaks
scan still reports 20 fixture/example/public-configuration matches, so a zero-match
history scan is **not** claimed and no blanket suppression was added.

The rehearsal changed all 1,828 commit IDs and 424 refs, including 392 PR heads and
one PR merge ref. History rewriting strips commit signatures and changes descendant
IDs, including commits whose file contents did not change. This would disrupt open
branches and PR references. The private replacement file, callback, rewritten
mirror, and commit/ref maps are retained outside the repository for owner review.
This snapshot must be refreshed after the cleanup PR is merged; it must not be
pushed wholesale or used to overwrite work added since the audit.

The document transformation is reviewable in
[`scripts/public-release/sanitize-docs.py`](../scripts/public-release/sanitize-docs.py).
It is a `git-filter-repo` callback body, not an application script. In a **fresh,
disposable mirror** with all intended branch/tag/PR refs fetched, the rehearsed
transformation is:

```sh
git filter-repo --sensitive-data-removal --invert-paths \
  --path evidence/ --path INVESTIGATION.md --path IMPLEMENTATION.md \
  --path PRODUCTION-CUTOVER-42.md --path database/supabase/.temp/ \
  --path supabase/.temp/ --path .env.development --path .env.production \
  --replace-text /private/incident-replacements.txt \
  --replace-message /private/incident-replacements.txt \
  --blob-callback /reviewed-checkout/scripts/public-release/sanitize-docs.py
```

The replacement file contains only the four owner-reviewed incident references;
keep it private. Before any push, repeat object/path scans, compare the current
tree, inspect every changed ref, and coordinate open work. GitHub PR refs are
server-managed; rewriting branch heads does not remove their old copies. GitHub
Support determines whether a disclosure qualifies for cached-data removal.

## External steps before changing visibility

1. Revoke or rotate any exposed credentials and record confirmation privately.
   Remove sensitive text from issues, comments, PR descriptions, review comments,
   attachments, logs, and artifacts as applicable. Deleting an issue is separate
   from deleting its Git history. Closing it does not hide it from public readers.
2. If historical removal is needed, prepare a disposable mirror that includes all
   branches, tags, and PR heads. Use `git-filter-repo` with a private replacement
   file or explicit paths; scan the rewritten copy and inspect changed refs before
   a coordinated force-push. Do not put replacement values in the PR, shell
   history, or this document. Coordinate existing clones/forks and contact GitHub
   Support about cached views, PR refs, and orphaned LFS data where applicable.
3. Enable GitHub secret scanning and push protection when available. Both were
   disabled at review time. Make `Secret scan / gitleaks` a required check after
   confirming the check name in a completed workflow run.
4. Change default Actions token permissions from write to read and disable Actions
   approval of PRs. At review time the token default was write and PR approval was
   enabled. Require approval for outside-contributor workflow runs when public,
   and keep fork write tokens/secrets disabled.
5. Review branch/environment protection and OIDC bindings. At review time `main`
   required `CI` but zero approving reviews; the `production` environment had no
   reviewers or branch restrictions. Restrict production to the intended release
   branch, require trusted review of workflows, and verify preview credentials
   cannot read production data or use a broader-than-needed deployment token.
6. Review retained Actions logs/artifacts, release assets, LFS objects, wiki,
   image/document attachments, and external linked content. Text scanning alone
   does not certify those surfaces. Recheck content added after the audit snapshot.
7. Only after the owner signs off on the remaining findings, change visibility and
   verify public access, issue/PR rendering, and contributor CI behavior.

For the history procedure and its limits, see
[GitHub's sensitive-data removal guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
For fork and workflow trust boundaries, see
[GitHub's secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
