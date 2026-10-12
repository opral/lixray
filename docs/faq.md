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

[Lix](https://github.com/opral/lix) is MIT licensed. You can
[self-host](./self-host.md) the Lix server and the Atelier UI today. The
LixRay repository, with sign-in, sharing, and the MCP server, is being open
sourced.

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

Not yet. Tokens and agent connections have your full account permissions.
There are no read-only or per-repository scopes.

## Can I get my data out?

Yes. Download a repository as a ZIP of its files. Read table data with SQL.
Lix is MIT licensed.

## What does it cost?

See [Pricing](/pricing).
