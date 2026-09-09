# What is LixRay?

LixRay is a host for [Lix](https://lix.dev/) repositories.

Lix is a repository designed for work outside software engineering:
files, a database, and version control over both. Git tracks changed
lines in text files. Lix tracks semantic changes in any file format: the
row that changed in a CSV, the paragraph that changed in a Markdown
file, the slide that changed in a deck.
Plugins map each file format to entities, and every entity change is
recorded with who made it, when, and what exactly changed.

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

Because changes are semantic, diffs are real diffs (cell by cell,
paragraph by paragraph) instead of byte blobs, and any change is
reversible to any point. People and agents share the same repository and
see changes as they happen.

LixRay adds:

- **Hosting**: repositories are stored, versioned, and available at a URL.
- **Browser UI**: read, edit, and review changes without local tooling.
- **Sharing**: every file has a URL; read-only by default, edit by invite.
- **Agent access**: agents connect over MCP with OAuth-scoped permissions.

Today the host powers the LixRay app at lixray.com. In the future it can
back anything built on Lix that wants hosted, shared repositories without
running its own infrastructure. If you want to build on top of LixRay,
email [hello@opral.com](mailto:hello@opral.com).

## Internal apps

Lix repositories have a SQL interface and JavaScript bindings. Companies can
build internal apps on top of their repository: a task tracker, an approval
queue, or a dashboard alongside the files and context their teams already use.
Application data can share the repository's version history.

[Build a mini app](./internal-apps.md) to try it with a small task tracker.

## Next steps

- [MCP](./mcp.md) — the LixRay MCP server in depth.
