# lixray

Minimal Cloudflare Worker + Durable Object Container + SlateDB KV service.

## API

- `GET /healthz` returns Worker health without auth or container startup.
- `GET /v1/container-health` checks the Rust container after auth.
- `PUT /v1/kv/:key` stores the raw request body.
- `GET /v1/kv/:key` returns raw bytes or `404`.
- `DELETE /v1/kv/:key` deletes a key.

All `/v1/*` routes require:

```text
Authorization: Bearer <LIXRAY_AUTH_TOKEN>
```

## Local development

Install dependencies:

```sh
pnpm install
```

Copy `.dev.vars.example` to `.dev.vars`. For local smoke tests without R2, run:

```sh
pnpm dev:memory
```

Smoke test:

```sh
curl http://127.0.0.1:8787/healthz
curl -X PUT http://127.0.0.1:8787/v1/kv/test \
	-H "Authorization: Bearer dev-token" \
	--data-binary "hello"
curl http://127.0.0.1:8787/v1/kv/test \
	-H "Authorization: Bearer dev-token"
```

## R2 setup

Create an R2 bucket and an R2 S3 API token with object read/write access. Configure:

```sh
pnpm wrangler secret put LIXRAY_AUTH_TOKEN
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
```

Set non-secret values in Cloudflare Workers variables or in `wrangler.jsonc`:

```text
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_BUCKET=<bucket-name>
R2_REGION=auto
SLATEDB_PATH=lixray/default
```

## Deploy

Manual deploy:

```sh
pnpm deploy
```

Workers Builds:

- Project root: `submodule/lixray`
- Production branch: `main`
- Build command: `pnpm check`
- Deploy command: `pnpm wrangler deploy`
- Worker name in Cloudflare must match `name` in `wrangler.jsonc`: `lixray`

## Checks

```sh
pnpm check
docker build .
```
