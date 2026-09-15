# Published file rendering with a local Lix

Lixray downloads authorized file bytes into a disposable in-memory browser Lix.
The viewer receives this client and the original file ID and renders AtelierFile.
The browser does not speak the remote Lix protocol for public views.

## Download boundary

`GET /api/published/lix/:repositoryId/file?id=:fileId&path=:path`:

1. Validates the canonical path and checks publication access through the existing resolver.
2. Opens the source using the real SDK in remote mode on the Lixray server.
3. Executes a fixed, parameterized query matching both file ID and authorized path.
4. Returns only the file bytes as an uncached binary download and closes the SDK session.

The SDK owns session creation, protocol version headers, queries and cleanup.
Caller-supplied SQL, protocol headers and credentials are never forwarded by this endpoint.
Private files and source history are not copied. Upstream authorization/session failures
are service errors; only publication authorization or a missing matching file yields an unavailable file.
Protocol mismatch remains HTTP 426 and service failures return HTTP 502.

## Browser and Atelier

The loader creates a fresh local Lix and inserts the document's original ID, path
and bytes. Referenced Markdown images are resolved against public metadata and
independently downloaded through the same endpoint before being inserted locally.
Unpublished assets are excluded. Executable Atelier extension paths are excluded.
A fresh Lix also has its own standard system rows, including `/.lix/README.md`.

Atelier's existing asset loader supplies object URLs for the standalone read-only
Markdown view. URLs are released when content changes or the component unmounts,
including results that arrive after cleanup. Lixray implements no second renderer.
The view owner closes the local Lix when navigation aborts or the view unmounts.
Local mutations cannot change the source repository.

This is a downloaded snapshot: reloading fetches current content. Unpublishing
prevents subsequent downloads; bytes already downloaded remain in the reader's browser.
Document and image downloads are separate reads, not one atomic repository snapshot.

## Validation and rollout

- `pnpm --dir web-app test:published`: real browser SDK and Atelier, with stubbed
  download/metadata responses. Covers Markdown, image rendering, original file ID,
  local isolation, absence of browser protocol calls, and 426/503/404 messages.
- `published-file.test.ts`: real remote SDK with a controlled protocol transport.
  Covers automatic version headers, exact ID/path reads, authorization denial,
  invalid paths, upstream failures and session cleanup.
- The Compose API-token e2e test publishes Markdown, opens it in an anonymous
  browser against the real server and denies a fresh download after unpublishing.
  The full Compose/Supabase test remains to be run before production promotion.
- Atelier tests cover standalone asset loading and cleanup.

There are no Lix engine or reference-server changes. The pinned Atelier revision
includes the standalone Markdown asset loader changes.
