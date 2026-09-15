# Partial replica deployment

LixRay uses the upstream Lix reference-server image resolved from the exact
`vendor/lix` revision and server content hash. The browser SDK and server must
come from that same revision (server protocol 10, sync protocol 16). Use the
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

Existing server repositories require a separate rollout check. The pinned
reference-server binary does not expose the old custom server's
`upgrade-authority` command. The native SDK provides
`upgrade_authority_for_partial_sync` for an operator tool holding exclusive
storage ownership, but that tool is not included in LixRay. If an existing
repository reports `LIX_AUTHORITY_UPGRADE_REQUIRED`, preserve its data and stop
the rollout until an operator migration tool is available; do not reset the
repository or substitute a new physical storage ID. Ordinary format migration
and authority-marker migration are distinct requirements.
