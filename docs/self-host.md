# Self-hosting

LixRay's [control plane](https://github.com/opral/lixray) is open source and
MIT licensed. The fastest way to self-host your repositories is to run a
[Lix server](https://github.com/opral/lix/tree/main/packages/server). You do not
need to deploy LixRay's control plane to store and access Lix repositories.

## Host your repositories with the Lix server

You can run the [Lix server](https://github.com/opral/lix/tree/main/packages/server)
on your own infrastructure and connect through the Lix SDK or server protocol.
It stores repositories and their version history in S3-compatible object storage.
Lix is MIT licensed. See the server README for configuration and deployment.

Lix repositories carry their files, tables, configuration, and history. The
LixRay control plane is not required to use the Lix server. The server does not
include LixRay's account management, sharing, or MCP endpoint. Supply your own
access controls and authentication gateway when exposing it to clients.

[Atelier](https://github.com/opral/atelier) is the MIT-licensed repository UI.
Developers can integrate it with their own Lix setup; that requires wiring a Lix
session and authentication rather than installing a complete LixRay service.

## Host the LixRay control plane

LixRay adds accounts, organizations, access management, repository discovery,
sharing, and MCP access around the Lix server. Its control plane uses Supabase
and the web application in this repository.

A supported self-hosted deployment of the full control plane is **TBD, pending
demonstrated interest**. We have not committed to deployment packaging,
upgrade support, or a timeline. Running the contributor development stack is
not a supported production deployment.

If you need the control plane as well as repository hosting, tell us your use
case in [the demand-gathering issue](https://github.com/opral/lixray/issues/610) or email
[hello@opral.com](mailto:hello@opral.com). This helps us decide whether to invest
in it. For control of repository storage and SDK access, start with the Lix server.
