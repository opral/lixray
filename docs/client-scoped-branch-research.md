# Client-owned state in Lix

Date: 2026-07-22

Status: implemented MVP design

## Decision

Remote workspace data stays on the server. State owned by one browser client is
stored in a separate local Lix snapshot:

```ts
import { openLix } from "@lix-js/sdk";
import { LocalStorage } from "@lix-js/sdk/local-storage-adapter";

const lix = await openLix({
  server: { mode: "remote", url },
  storage: new LocalStorage(),
});

const previous = lix.clientState.get("atelier_session_ui");
await lix.clientState.set("atelier_session_ui", nextUiState);
```

The root package is the only `openLix` entrypoint. The former
`@lix-js/sdk/remote` subpath has been removed. `./remote-protocol` remains public
for server implementations.

## Ownership model

| Data | Owner and placement |
|---|---|
| Files, changes, branches, shared records | Remote workspace |
| Active branch selection | Local client snapshot plus branch-pinned server session |
| Atelier tabs, views, focus, and panels | Local client snapshot |
| Atelier panel-size preferences | Local client snapshot |
| Review decisions | Shared application storage |

Client state is not a third row scope beside tracked and untracked data. It is
a separate physical database with a separate lifetime. This avoids making
workspace SQL a distributed query across browser and server databases.

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

`openLix()` hydrates the local snapshot before resolving, so `get()` is
synchronous. Mutations run through the local Rust Lix and persist a fresh opaque
snapshot only after the mutation succeeds.

## Active branch behavior

The public API is unchanged:

```ts
await lix.activeBranchId();
await lix.switchBranch({ branchId });
```

The SDK stores the last successful selection in client state under
`lix_active_branch_id`. When reopening:

1. The local snapshot is hydrated.
2. The stored branch ID seeds the remote handshake.
3. The server validates it and creates an independent branch-pinned session.
4. If the branch was deleted, the SDK opens the server default and repairs the
   local value.

Switching replaces only that protocol session's pinned branch and restarts its
observations. It does not write the workspace branch selector, so another
client is unaffected. SQL such as `lix_active_branch_id()` continues to work
because it resolves against the requesting client's pinned server session.

## Browser persistence and isolation

`LocalStorage` implements the generic opaque `LixSnapshotStorage` contract. The
SDK namespaces snapshots by normalized remote URL. Lixray additionally prefixes
the adapter with the authenticated account ID, producing account and workspace
isolation without exposing authentication concepts in Lix itself.

Lixray opens one persisted client-state owner for each mounted workspace. Other
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
- Root workspace SQL cannot join remote tables with local client-state rows.
- Multiple independently opened handles must not concurrently write the same
  snapshot namespace.
- Cross-tab live synchronization is not part of the MVP.
- Existing UI state in legacy session-storage, local-storage, or hosted records
  is not migrated into the new client snapshot.
