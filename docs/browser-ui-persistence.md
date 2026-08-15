# Browser UI persistence

Lixray deliberately separates repository data from browser UI state.

- The remote Lix is the sole repository authority. Opening it does not create a
  second local IndexedDB-backed Lix.
- Atelier shell state (open views, focus, and other tab-local navigation) is
  stored in `sessionStorage`, namespaced by account and repository. Each browser
  tab therefore has an independent workspace, while reloads in that tab restore
  it.
- Authenticated user preferences are stored in `user_lix_preferences` through
  Supabase. Anonymous/demo preferences use `sessionStorage`.
- Review-resolution state keeps its existing account-backed persistence and
  offline browser staging.

This follows the browser's ownership model: repository state belongs to Lix,
durable user preferences belong to the user account, and transient window/tab
state belongs to the browser tab. A future decision to make a UI artifact
collaborative should model it as an explicit repository entity instead of a
hidden client-side Lix.
