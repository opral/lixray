# FAQ

## Is it just git plus SQLite plus an MCP server?

Partly. Git versions files, not rows. A database stores rows with no history.
Lix keeps both in one history, so one change can touch a file and a row, and
you can undo it as one. LixRay hosts it behind one MCP endpoint. Claude,
ChatGPT, Codex, and your scripts can all use it.

## Do I have to run a server?

No. Use hosted repositories on lixray.com, or embed Lix in your app with
`npm install @lix-js/sdk`. Lix runs in-process. Storage can be memory,
filesystem, browser OPFS, or S3.

## Is it open source?

[Lix](https://github.com/opral/lix) and [Atelier](https://github.com/opral/atelier)
are MIT licensed. LixRay is also MIT licensed; its control-plane source is being prepared for public release.

## Can I self-host it?

You can self-host the Lix server to store and access your repositories without
LixRay's control plane. A supported deployment of the full LixRay control plane
is TBD, pending demonstrated interest. See [self-hosting](./self-host.md) and
[the demand-gathering issue](https://github.com/opral/lixray/issues/610).

## How are changes diffed?

Row by row. A plugin splits a file into rows: a Markdown block, a CSV record,
or a spreadsheet cell. The SDK includes Markdown and CSV plugins. Tables you
register in SQL diff per row. Files without a plugin keep whole-file history.

## How do I undo a change?

Every change is in the repository's history. Undo it, or restore any earlier
version, from the repository view or through MCP.

## What happens when two agents change the same thing?

- Edits to different rows, or different columns of one row, combine.
- If two writes change the same column, the last write the server accepts
  wins.
- A file without a plugin is replaced as a whole, so the last write wins.

No edit stops on a merge conflict. An MCP batch can pass the last commit the
agent saw. If the repository has moved, the server refuses the whole batch.

## Who is a change attributed to?

LixRay records each change under the account that made it. An agent you
connect writes as you.

## Can I limit what an agent or token can access?

Repository API tokens are scoped to one repository and inherit the creator's
current access there. Account tokens and MCP connections use your account's
permissions. Read-only or path-level token scopes are not available. See
[access tokens](./access-tokens.md).

## Can I get my data out?

Yes. Download a repository as a ZIP of its files. Read table data with SQL.
Lix is MIT licensed.

## What does it cost?

See [Pricing](https://lixray.com/pricing).
