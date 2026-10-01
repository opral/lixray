# Partial replica deployment

LixRay uses the upstream Lix reference-server image resolved from the exact
`vendor/lix` revision and server content hash. The browser SDK and server must
come from that same revision. The native candidate uses server protocol 12,
sync protocol 25, and storage format 85; resolve these values from the pinned
engine using `node vendor/lix/scripts/compatibility.mjs`. Use the
existing image resolver and preview workflow; the removed custom `lix-server`
source and its Dockerfile are not part of this deployment.

Full-repository public access permits bounded native hydration and read-lease
renewal. Path-only publications do not: a canonical native object can contain
rows outside the published path. Those sessions use the remote file transport,
and the worker rejects native hydration before forwarding it. Authenticated
repository members retain full protocol access.

Preview validation uses disposable storage isolated from production. Existing
browser replicas retain their OPFS name and migrate explicitly when the SDK
reports that migration is required; opening must never reset their storage.

The production editor prepares the selected existing file's native content and
branch write frontier before exposing document operations. Ordinary content
updates remain native local commits; publication runs asynchronously. Other
plugin inputs remain demand-driven and are qualified by the real editor and
history/conflict integration gates rather than inferred from the plaintext
prototype.

Automatic partial-replica cache eviction stays disabled. Mutable/immutable
storage labels do not identify ownership by pending commits, prepared scopes,
or retained recovery sources. Browser quota and persistence are checked
independently of native commit durability. Retained app-routed sibling stores
are downloadable under both OPFS ownership fences without opening or migrating
their Lix format. Physical archives preserve journal bytes, but do not claim
automatic semantic import across arbitrary unsupported formats.

A full replica with an unfinished source-bank conversion journal cannot advance
to a new format bank: the preflight fails before changing the active pointer.
Resume its exact conversion in a compatible recovery environment or preserve a
physical archive for support recovery; do not generate a new attempt or delete
the old bank to bypass this state.

Existing server repositories require a separate rollout check. The pinned
reference-server binary does not expose the old custom server's
`upgrade-authority` command. The native SDK provides
`upgrade_authority_for_partial_sync` for an operator tool holding exclusive
storage ownership, but that tool is not included in LixRay. If an existing
repository reports `LIX_AUTHORITY_UPGRADE_REQUIRED`, preserve its data and stop
the rollout until an operator migration tool is available; do not reset the
repository or substitute a new physical storage ID. Ordinary format migration
and authority-marker migration are distinct requirements.

## Release qualification and recovery

Resolve the SDK and authority image from the committed Lix gitlink; never pair
a newly built SDK with the previous server protocol. The engine gate must
include `--all-features` runtime HTTP tests and the tooling `lix_e2e` suite,
in addition to the mandatory all-simulations and doctest gates. The narrower
all-simulations gate alone does not exercise file-plugin hydration over HTTP.

The Production workflow validates the exact web/server image pair through
editor, navigation, history and conflict tests before applying migrations and
promoting both services. Confirm the deployed compatibility contract and
production canary after promotion. A successful authority SQL query does not
prove an affected browser's persisted replica has upgraded.

For an affected device, close other tabs using the same repository before
downloading a saved device copy. The backup operation takes the provider's
worker-owner and SQLite ownership fences, reads the physical OPFS directory
without opening its engine, and releases both fences on success or failure.
The archive is private repository data. Preserve it locally and restore only
inside an isolated compatible recovery environment; never overwrite the
active browser store. Source data exceeding the current 64 MiB limit fails
without modifying the source; ZIP headers and the manifest add output bytes.

Check persistent-storage permission and quota separately from local commit
success. When permission is denied or usage reaches 80 percent, the editor
offers a current snapshot download. Retained sibling copies remain available
from the recovery control even when native opening fails. Replacement retry
uses a persisted attempt identity and the authority's canonical response, so
a lost acknowledgment cannot silently select another physical store.

Keep automatic eviction disabled until ownership-aware collection can prove
that each candidate is absent from pending commit, prepared-scope and recovery
roots. An immutable storage key can still contain irreplaceable unpublished
work; its mutability label alone is not permission to discard it.
