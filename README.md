# LixRay

**A shared repository for you and your AI agents.**

Files and SQL tables live together with version history. Claude, ChatGPT, Codex,
and your scripts read and write the same repository through MCP or the Lix SDK.
Use the hosted app at [lixray.com](https://lixray.com).

LixRay is built on [Lix](https://github.com/opral/lix), the MIT-licensed engine
for files, tables, and version control, and [Atelier](https://github.com/opral/atelier),
the repository UI. This repository contains LixRay's web app, MCP server, and
control plane for accounts, access, sharing, and hosting. It is [MIT licensed](LICENSE).

## What you can do

- Keep documents, files, and SQL tables in one repository.
- Connect multiple agents to the same data through one MCP endpoint.
- Inspect changes, create branches and checkpoints, undo edits, and restore history.
- Use the SDK and SQL to build scripts and apps around your data.

Connections to Google Drive, Notion, GitHub, and Granola are
[planned](https://github.com/opral/lix/issues/1934). Automations are also planned.
Agent edits are attributed to the connected user's account.

## Connect an agent

Create a repository at [lixray.com](https://lixray.com), then add
`https://lixray.com/mcp` as a remote MCP server in your client and sign in with OAuth.
See [getting started](docs/getting-started.md) and the [MCP reference](docs/mcp.md).

## Use the SDK

```sh
npm install @lix-js/sdk
```

Create a repository API token under **Settings → API tokens**. Use the repository
ID from its connection URL and keep the token in your server or script environment:

```ts
import { openLix } from "@lix-js/sdk";

const lix = await openLix({
  server: {
    url: `https://lixray.com/lix/${process.env.LIXRAY_REPOSITORY_ID}`,
    headers: {
      Authorization: `Bearer ${process.env.LIXRAY_API_TOKEN}`,
    },
  },
});

try {
  await lix.execute("INSERT INTO lix_file (path, content) VALUES ($1, $2)", [
    "/status.txt",
    new TextEncoder().encode("ready"),
  ]);
} finally {
  await lix.close();
}
```

To try Lix without an account, open an in-memory repository with `await openLix()`.
See [access tokens](docs/access-tokens.md) for repository and account token scopes.

## Self-hosting

You can self-host the [Lix server](https://github.com/opral/lix/tree/main/packages/server)
to store and access your repositories on your own infrastructure. You do not need
LixRay's control plane to use Lix through its SDK and server protocol.

Self-hosting the full LixRay control plane is **TBD, pending demonstrated interest**.
We have not committed to a packaged deployment or support timeline.
See [self-hosting](docs/self-host.md) for the distinction and tradeoffs, and
[#610](https://github.com/opral/lixray/issues/610) to share a control-plane use case.

## Contributing

Requirements: Node.js 24, pnpm 10.13.1, Docker, and the Supabase CLI.

```sh
git clone --recurse-submodules https://github.com/opral/lixray.git
cd lixray
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:8787` and choose **Continue as local developer**.
Local development does not require the team's Infisical credentials.
See [development](docs/development.md) for setup, architecture, and validation,
and [operations](docs/operations.md) for hosted deployment procedures.

- `web-app/`: web app, MCP server, and Atelier integration
- `database/`: Supabase migrations and database tests
- `vendor/`: pinned Lix and Atelier submodules
- `perf/`: reproducible performance tooling

Report bugs and feature requests in [GitHub issues](https://github.com/opral/lixray/issues).
For private security reports, see [SECURITY.md](SECURITY.md).
Pricing for the hosted service is at [lixray.com/pricing](https://lixray.com/pricing).
