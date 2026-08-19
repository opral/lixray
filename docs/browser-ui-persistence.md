# Browser UI persistence

Lixray deliberately separates repository data from browser UI state.

- The server remains the repository authority. Atelier opens one durable OPFS
  replica in `server.mode: "sync"`; reads and writes use that local replica while
  synchronization runs outside the interaction path.
- Atelier shell state (open views, focus, and other tab-local navigation) is
  stored in `sessionStorage`, namespaced by account and repository. Each browser
  tab therefore has an independent workspace, while reloads in that tab restore
  it.
- User preferences are transient tab-local state in `sessionStorage`. They are
  not persisted in the LixRay control-plane database; durable
  repository-scoped preferences must be modeled inside the Lix.
- Review-resolution state is also transient tab-local state in `sessionStorage`.
  It is not persisted in the LixRay control-plane database.

This follows the browser's ownership model: repository state, including durable
repository-scoped preferences and review resolutions, belongs to Lix, while
transient window/tab state belongs to the browser tab. A future decision to make
a UI artifact collaborative should model it as an explicit repository entity
instead of a hidden client-side Lix.
