# Existing repositories rejected as sync replicas

## Cause

The deployed Lix revision `11766ec879ca5e06de18dd724878be168b5fe721`
diverged from the upstream authority-storage layout. It treated every row in
`sync.replica_state.v3` as a replica receipt and expected the authority marker in
a separate space. The preceding production revision `c99513a56` stored the
authority marker in the shared sync-control space instead:

| Field | Persisted value |
| --- | --- |
| Logical space | `0x00070014` (`sync.replica_state.v3`) |
| Key | `authority` |
| Value | `certified-authority-v4` |

Consequently an existing authority failed admission with
`a persisted sync replica cannot be served as a protocol authority`, surfaced
by the server as `LIX_INTERNAL_ERROR: Unable to open lix.` This happens before
Atelier or the file route opens; Markdown link handling is unrelated.

## Fix

Pin the browser SDK and server together to upstream main revision
`9d1882b6d0d36c3ce4fa3d2c2f044d2e140ac5f3`, whose CI passed. It retains the
shared-space authority representation and excludes only the exact authority
key/value pair from replica detection. Real replica receipts and malformed
markers are still rejected. No repository repair, cache reset, or deletion is
required. Existing browser clients may need a reload because the paired sync
protocol changes from version 5 to 6.

## Verification

- Downloaded an isolated copy of the affected repository's object-storage
  prefix using read-only access; no production objects were modified.
- The exact deployed server image (Lix `11766ec`) reproduced HTTP 500 and the
  authority/replica admission error against that copy.
- Raw inspection found an active format-77 epoch containing only the authority
  marker above in the sync-control space, not a replica receipt.
- A server built from `9d1882b6d` opened the same copy with HTTP 200 and read its
  six files and 50 commits, including both reported Markdown paths.
- The selected upstream revision includes
  `durable_authority_marker_fences_a_second_plain_engine` (including close and
  reopen) and `persisted_sync_replica_cannot_be_served_as_an_authority` coverage.

The production copy is not committed or attached to the PR. New-repository
tests alone are insufficient for dependency qualification: verify reopening
existing authority storage, and keep browser and server revisions paired.
