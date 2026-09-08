# File component browser QA

Run `pnpm test:file-component` from `web-app`. The separate Vite fixture renders the real `DirectoryView`, React Aria interactions, Radix dialogs, and application theme. It requires no OAuth account, database, Docker services, or Lix WASM build.

The in-memory Lix adapter supplies observed query results and mutations, including directory descendants and transaction rollback. This suite verifies browser behavior rather than the SDK's SQL implementation; `pnpm test:repository` separately covers file-operation validation and transaction contracts. The fixture is test-only and is not included in the application routes.

The fixture is also available interactively at `http://127.0.0.1:8795` after running `pnpm exec vite --config tests/file-component/vite.config.ts`. Append `?readonly` to review the read-only experience. `window.directoryQA` exposes recorded calls, entries, `setWriteDelay(milliseconds)`, and `failNextWrite()` for latency and error checks.

External drag-and-drop cases use Chromium’s native drag events with temporary files and nested folders on disk, including empty folders. They exercise browser file handles without stubbing DataTransfer. The suite also covers main’s hidden-file preference, immutable history listings, diff-aware opening, and open-folder reconciliation after external changes.
