# lixray

Minimal Cloudflare Worker + Durable Object Container + SlateDB KV service.

Production is deployed at:

```text
https://api.lixray.com
```

Cloudflare state:

- Account: `Opral` (`11a1a6f76d167248cc6987e978efb7e5`)
- Zone: `lixray.com`
- Worker: `lixray`
- Custom Domain: `api.lixray.com`
- R2 bucket: `lixray`
- SlateDB path: `lixray/default`

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

Production smoke test:

```sh
TOKEN='<LIXRAY_AUTH_TOKEN>'

curl -i https://api.lixray.com/healthz
curl -i https://api.lixray.com/v1/container-health \
	-H "Authorization: Bearer $TOKEN"

curl -i -X PUT https://api.lixray.com/v1/kv/test \
	-H "Authorization: Bearer $TOKEN" \
	--data-binary "hello lixray"
curl -i https://api.lixray.com/v1/kv/test \
	-H "Authorization: Bearer $TOKEN"
curl -i -X DELETE https://api.lixray.com/v1/kv/test \
	-H "Authorization: Bearer $TOKEN"
curl -i https://api.lixray.com/v1/kv/test \
	-H "Authorization: Bearer $TOKEN"
```

Expected responses: health `200`, container health `200`, put `204`, get
returns the stored bytes, delete `204`, final get `404`.

## Local development

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets. `.dev.vars` is
ignored and must not be committed.

Run local development without R2:

```sh
pnpm dev:memory
```

Then smoke test locally:

```sh
TOKEN='dev-token'

curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/v1/container-health \
	-H "Authorization: Bearer $TOKEN"
curl -i -X PUT http://127.0.0.1:8787/v1/kv/test \
	-H "Authorization: Bearer $TOKEN" \
	--data-binary "hello"
curl -i http://127.0.0.1:8787/v1/kv/test \
	-H "Authorization: Bearer $TOKEN"
```

Run local development against the real R2 bucket only when deliberately testing
production-like storage:

```sh
pnpm dev
```

## Iteration workflow

Before deploying:

```sh
pnpm check
docker build .
pnpm run deploy:worker --dry-run
```

Deploy:

```sh
pnpm run deploy:worker
```

The `deploy:worker` script is used instead of `pnpm deploy` because `pnpm
deploy` is pnpm's own workspace command.

Workers Builds should use:

- Project root: `submodule/lixray`
- Production branch: `main`
- Build command: `pnpm check`
- Deploy command: `pnpm run deploy:worker`
- Worker name: `lixray`

## Runtime config

Non-secret production values are checked into `wrangler.jsonc`:

```text
R2_ENDPOINT=https://11a1a6f76d167248cc6987e978efb7e5.r2.cloudflarestorage.com
R2_BUCKET=lixray
R2_REGION=auto
SLATEDB_PATH=lixray/default
SLATEDB_STORAGE=r2
```

Production secrets live in Cloudflare Worker secrets:

```text
LIXRAY_AUTH_TOKEN
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

To rotate a secret:

```sh
pnpm wrangler secret put LIXRAY_AUTH_TOKEN --config ./wrangler.jsonc
pnpm wrangler secret put R2_ACCESS_KEY_ID --config ./wrangler.jsonc
pnpm wrangler secret put R2_SECRET_ACCESS_KEY --config ./wrangler.jsonc
```

Create or recreate the R2 bucket:

```sh
pnpm wrangler r2 bucket create lixray
pnpm wrangler r2 bucket list
```

R2 S3 credentials are created in the Cloudflare dashboard under R2 API tokens.
Use an account token with Object Read & Write access scoped to the `lixray`
bucket.
