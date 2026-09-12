# LixRay Privacy Policy

Last updated: 12 September 2026

This policy describes how **Opral US Inc.** (“we”) handles personal data when you use LixRay at [lixray.com](https://lixray.com), including the remote MCP server at `https://lixray.com/mcp`.

Contact: [hello@opral.com](mailto:hello@opral.com)

## What we collect

**Account.** When you sign in with Google we receive the name, email address, and profile identifier Google provides. We store the account in Supabase.

**Repository content.** Files, SQL rows, and version history you put in a LixRay repository. You control that content. Through the MCP connector, share only the specific non-sensitive content needed for your current task. Do not submit health information, biometric data, government identifiers, payment card data, passwords, API keys, or other authentication secrets. The connector is not intended to collect these categories or import chat history or remembered personal profiles.

**MCP access.** When an MCP client connects, we complete OAuth (scopes: `openid`, `email`, `profile`, and `offline_access`) and log tool use at a metadata level (which tool, success or error, timing). We do not store raw SQL or file contents in analytics.

**Usage.** Product analytics (page views, feature use, errors) via PostHog.

## Why we use it

To create and authenticate your account, host and sync your repositories, authorize MCP clients you connect, keep the service secure, and understand how LixRay is used so we can fix and improve it.

We do not sell personal data. We do not use repository contents to train foundation models.

## Who we share it with

We use processors that help us run LixRay:

- **Google** — sign-in
- **Supabase** — identity and application data
- **Railway** — application hosting
- **Cloudflare R2** — repository object storage
- **PostHog** (US) — product analytics, with MCP payloads redacted

We may disclose data if required by law, or to protect the service and other users.

## Retention

We keep account and repository data until you delete the account or the repository. Backups may persist for a short period after deletion. Analytics are kept only as long as needed to operate the product.

## Your rights

Email [hello@opral.com](mailto:hello@opral.com) to access, correct, or delete your account data, or to export repository content. You can disconnect an MCP client at any time by revoking access.

If you are in the EEA, UK, or a similar jurisdiction, you may also lodge a complaint with your local supervisory authority.

## Children

LixRay is not directed at children under 16.

## Transfers

Some processors are in the United States. If we transfer personal data out of the EEA or UK, we rely on the processor’s appropriate safeguards (such as Standard Contractual Clauses).

## Changes

We will post updates on this page and change the date above. Material changes will be announced in the product or by email when we have an address.

## Terms

Use of LixRay is also governed by the [Terms of Service](https://lixray.com/terms).
