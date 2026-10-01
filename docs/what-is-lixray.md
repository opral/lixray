# What is LixRay?

LixRay is a shared repository for you and your AI agents, and the official
host for [Lix](https://lix.dev/). It holds documents, files, and database
tables in one place. Claude, ChatGPT, or any MCP agent
reads and edits the same data, and every change is versioned.

```
you (browser)      agents (MCP)
      │                 │
      ▼                 ▼
┌──────────────────────────────┐
│ LixRay   hosting · UI · MCP  │
├──────────────────────────────┤
│ Lix      files + tables +    │
│          version control     │
└──────────────────────────────┘
```

[Lix](https://lix.dev/) is an open-source (MIT) version control system for files
and SQL tables. LixRay hosts Lix repositories and adds a web UI, sharing, and
MCP access for agents.

## What you get

- **One repository for everything.** Markdown, CSV, Excel, PDFs, images, and
  SQL tables live side by side.
- **Any agent.** Any MCP client, such as Claude, ChatGPT, Gemini, or Codex,
  connects with OAuth. See [MCP](./mcp.md).
- **Version control.** Every change records who made it and what changed.
  Markdown and CSV get structured diffs (paragraphs, rows). Other files keep
  whole-file history. Agents can work on a branch that you review and merge.
  You can restore any version.
- **Sharing.** Every file has a URL. Read-only by default, edit by invite.
- **No lock-in.** Files stay in their own formats. You can
  [self-host](./self-host.md) the storage server and the web UI. Sign-in,
  sharing, and the MCP server are not open source yet.

## Planned

- **Connect your sources.** Pull in Google Drive, Notion, GitHub, and Granola.
  Track it in [opral/lix#1934](https://github.com/opral/lix/issues/1934).
- **Automations.** Run checks and scripts on every change. Track it in
  [opral/lix#256](https://github.com/opral/lix/issues/256).

## Compared to

- **ChatGPT Space** only works with ChatGPT.
- **Anthropic Artifacts** only work with Claude.

Notion, Google Drive, and GitHub are sources, not alternatives. LixRay connects
to them.

## Internal apps

Repositories have SQL and a JavaScript SDK. You can build small
apps on top of a repository, such as a task tracker or an approval queue. Their
data shares the repository's version history.
[Build a mini app](./internal-apps.md) to try it.

## Next steps

- [Get started](./getting-started.md): create a repository, add files, and
  connect an agent.
- [MCP](./mcp.md): the LixRay MCP server in depth.
- [Self-host](./self-host.md): run LixRay on your own infrastructure.
