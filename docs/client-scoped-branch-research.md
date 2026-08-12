# Client-owned state in Lix

Date: 2026-07-22

Status: implemented MVP design

## Decision

Remote repository data stays on the server. State owned by one browser client
is stored in a separate local IndexedDB-backed Lix:

```ts
import { IndexedDbStorage, openLix } from "@lix-js/sdk";

const lix = await openLix({
  server: { mode: "remote", url },
  storage: new IndexedDbStorage({ name: "lixray.client.v2:account-id" }),
});

const previous = lix.clientState.get("atelier_session_ui");
await lix.clientState.set("atelier_session_ui", nextUiState);
```

The root package is the only `openLix` entrypoint. The Lix Server Protocol now
lives in the Rust `lix` crate behind its `server-protocol` feature.

## Ownership model

| Data | Owner and placement |
|---|---|
| Files, changes, branches, shared records | Remote repository |
| Active branch selection | LixRay route state plus branch-pinned server session |
| Atelier tabs, views, focus, and panels | Local client database |
| Atelier panel-size preferences | Local client database |
| Review decisions | Shared application storage |

Client state is not a third row scope beside tracked and untracked data. It is
a separate physical database with a separate lifetime. This avoids making
repository SQL a distributed query across browser and server databases.

In the Rust SDK, client state uses the normal Lix SQL and transaction path. Its
values are ordinary global, untracked `lix_key_value` rows stored under a
private physical prefix in the client-only Lix. The JS facade exposes the small
API needed by synchronous UI stores:

```ts
interface LixClientState {
  get<T extends JsonValue>(key: string): T | undefined;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
```

`openLix()` opens the local IndexedDB database before resolving, so `get()` is
synchronous. Mutations run through the local Rust Lix and persist directly to
that database.

## Active branch behavior

The public API is unchanged:

```ts
await lix.activeBranchId();
await lix.switchBranch({ branchId });
```

When reopening a remote LixRay repository:

1. The local IndexedDB-backed Lix opens.
2. The server creates an independent protocol session on its default branch.
3. LixRay restores the branch selected by the route with `switchBranch()`.
4. The client-state database retains account and UI preferences without
   sending a client-selected account through the handshake.

Switching replaces only that protocol session's pinned branch and restarts its
observations. It does not write the workspace branch selector, so another
client is unaffected. SQL such as `lix_active_branch_id()` continues to work
because it resolves against the requesting client's pinned server session.

## Browser persistence and isolation

`IndexedDbStorage` identifies a persistent local Lix by name. The SDK further
namespaces remote client state by normalized server URL. Lixray includes the
authenticated account ID in the database name, producing account and repository
isolation without exposing authentication concepts in Lix itself.

Lixray opens one persisted client-state owner for each mounted repository. Other
short-lived remote clients, such as archive and MCP helpers, stay storage-free.
This avoids concurrent whole-snapshot writers for the same namespace.

The two Atelier keys are public so other consumers holding the same `Lix`
handle can read them:

- `atelier_session_ui`
- `atelier_user_preferences`

Clearing browser storage creates a new client. A different browser profile or
device intentionally cannot read state that is never uploaded.

## Loading cost

Supplying browser storage starts the local Rust/Wasm engine. The emitted engine
is currently about 41.1 MB raw and 9.1 MB gzip. A real persistent Chrome profile
downloads those hashed bytes once while cached, but a new page still pays worker
startup, Wasm instantiation, and local-Lix hydration. This MVP deliberately
accepts that cost to keep one Rust implementation and one Lix state model.

Future optimization can place client-state functionality in a smaller Rust/Wasm
artifact. That requires a deliberate module or crate boundary; functions inside
one monolithic Wasm module cannot be network-fetched individually. The public
`openLix({ server, storage })` and `lix.clientState` APIs do not need to change
when that split happens.

## Explicit non-goals

- Client state is not synchronized to the server.
- Root repository SQL cannot join remote tables with local client-state rows.
- Multiple independently opened handles must not concurrently write the same
  snapshot namespace.
- Cross-tab live synchronization is not part of the MVP.
- Existing UI state in legacy session-storage, local-storage, or hosted records
  is not migrated into the new client database.
