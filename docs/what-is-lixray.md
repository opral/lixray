# What is LixRay?

LixRay hosts [Lix](https://lix.dev/) repositories. Lix is an open source
version control system for files and application data. It stores ordinary
files and SQL tables in one repository and versions changes to both.
LixRay gives people a browser app and gives agents access through MCP.

```
people (browser)      agents (MCP)
       │                   │
       ▼                   ▼
┌───────────────────────────────────┐
│  LixRay    hosting · sharing · UI │
├───────────────────────────────────┤
│  Lix       repository:            │
│            files + database +     │
│            version control        │
└───────────────────────────────────┘
```

File plugins provide structured diffs for supported formats, including
Markdown and CSV. Other files still have whole-file history. People and
agents can work in the same repository and review its changes.

LixRay adds:

- **Hosting**: repositories are stored, versioned, and available at a URL.
- **Browser UI**: read, edit, and review changes without local tooling.
- **Sharing**: every file has a URL; read-only by default, edit by invite.
- **Agent access**: agents connect over MCP with OAuth-scoped permissions.

The hosted app is at [lixray.com](https://lixray.com/). To build on LixRay,
email [hello@opral.com](mailto:hello@opral.com).

## Internal apps

Lix repositories have a SQL interface and JavaScript bindings. Companies can
build internal apps on top of their repository: a task tracker, an approval
queue, or a dashboard alongside the files and context their teams already use.
Application data can share the repository's version history.

[Build a mini app](./internal-apps.md) to try it with a small task tracker.

## Next steps

- [Get started](./getting-started.md) — create a repository, add files, and connect an agent.
- [MCP](./mcp.md) — the LixRay MCP server in depth.
