# Cold partial-replica file reads on dev-24-09

The reproduction uses 240 synthetic Markdown files, a 27-byte target file, a fresh descriptor-only partial replica per query, and the real Lix server protocol dispatcher over the Memory storage adapter. Every case ran warm again with zero sync requests. The local times show structural work, not a production latency estimate.

| Cold query | Before: sync requests | After: sync requests | Before: response bytes | After: response bytes |
| --- | ---: | ---: | ---: | ---: |
| `SELECT content ... WHERE id = $1` | 1 | 1 | 318–322 KB on the earlier revision | 97 KB |
| `SELECT id ... WHERE id = $1` | 8 | 1 | 41 KB | 30 KB |
| `SELECT id, path, content ... WHERE id = $1` | 9 | 1 | 154 KB | 97 KB |
| Prepared-file projection by ID | 9 | 1 | 154 KB | 97 KB |
| Prepared-file projection by path | 9 | 1 | 688 KB | 248 KB |

The pristine prepared-file query had seven sequential native metadata/object requests before it could record a file-read interest, then separate path and content fulfillments. The query planner now seeds a bounded file-point interest before branch resolution and provider setup; authority discovery sends the graph, path, and content closure together. SQL still evaluates locally, including aliases and projections. The exact-ID provider also scopes its path index so small-blob caching does not fetch unrelated files. The regression fixture asserts one fulfillment, two SQL attempts, one selected blob chunk for ID reads, and no warm network requests.

On this branch revision, the prepared-file read by ID fell from 820 to 474 authority storage calls and from 38 ms to 21 ms local cold elapsed. The path version fell from 13,485 to 12,116 calls and from 330 ms to 252 ms. These elapsed times use in-process Memory storage. The 318–322 KB baseline for `SELECT content` in the first row came from the earlier Lix revision used for initial discovery; the other baseline/new pairs were measured on `dev-24-09` with the exact-ID index prototype already present.

LixRay already resolves file ID and path in its route. It now passes both to Atelier, avoiding a second path resolution, and Atelier carries the ID into its file loader. The document-open lifecycle and branch checks remain in the existing open path.

No durable storage layout or physical keys changed, so no repository migration is required. Admission, descriptor acquisition, and background watches remain separate requests. A production backend A/B run is still required to quantify server idle time and navigation-to-visible p95.
