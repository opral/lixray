# Self-host

LixRay is two open-source parts:

- **[Lix server](https://github.com/opral/lix/tree/main/packages/server)**: stores repositories and their history. It runs as one binary (or Docker image) on top of S3-compatible object storage.
- **[Atelier](https://github.com/opral/atelier)**: the browser front end for files, tables, and changes.

Run the Lix server, point Atelier at it, and you have your own LixRay. Both are MIT licensed.

```
browser (Atelier)  ──►  Lix server  ──►  S3-compatible storage
agents (MCP, SDK)  ──►
```

The Lix server has no login, permissions, or billing built in. Put it behind your own gateway that handles authentication. See the [server README](https://github.com/opral/lix/tree/main/packages/server) for configuration.

## The LixRay repository

We plan to open source the LixRay repository itself (hosting, sign-in, sharing, and the MCP server). If you want access before that, email [hello@opral.com](mailto:hello@opral.com).
