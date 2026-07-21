# Getting Started

## What is LixRay?

LixRay is a hosted service for [Lix](https://lix.dev/) workspaces.

Lix is the open-source change control system: a Lix workspace is a set of
plain files — Markdown, CSV, images — where every change is tracked with who
made it, when, and what exactly changed. Changes are reviewable as diffs and
reversible to any point.

LixRay runs those workspaces as a service, so nobody has to operate the
infrastructure themselves:

- **Hosting** — workspaces are stored, versioned, and available at a URL.
- **Browser UI** — read, edit, and review changes without local tooling.
- **Sharing** — every file has a URL; read-only by default, edit by invite.
- **Agent access** — agents connect over MCP with OAuth-scoped permissions.

Today the host powers the LixRay app at lixray.com. In the future, it can
back custom solutions that need a Lix host — anything built on Lix that
wants hosted, shared workspaces without running its own infrastructure.

## Next steps

- [MCP](./mcp.md) — the LixRay MCP server in depth.
