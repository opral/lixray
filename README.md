# lixray

Cloudflare Worker + Durable Object Container exposing Lix over HTTP, backed by
SlateDB on R2.

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
- `GET /v1/branches` lists Lix branches so clients can discover the
  generated `main` branch id.
- `POST /v1/createBranch` creates a branch from a supplied `branchId`.
- `POST /v1/execute` executes one Lix SQL statement on a supplied
  `branchId`.
- `POST /v1/observe` streams Lix observe events as POST SSE.

All `/v1/*` routes require:

```text
Authorization: Bearer <LIXRAY_AUTH_TOKEN>
```

Values use Lix wire values:

```json
{ "kind": "text", "value": "hello" }
{ "kind": "blob", "base64": "aGVsbG8=" }
```

Production smoke test:

```sh
TOKEN='<LIXRAY_AUTH_TOKEN>'

curl -i https://api.lixray.com/healthz

curl -i https://api.lixray.com/v1/branches \
	-H "Authorization: Bearer $TOKEN"

BRANCH_ID="$(curl -fsS https://api.lixray.com/v1/branches \
	-H "Authorization: Bearer $TOKEN" \
	| jq -r '.branches[] | select(.name == "main") | .id')"

curl -i -X POST https://api.lixray.com/v1/execute \
	-H "Authorization: Bearer $TOKEN" \
	-H "content-type: application/json" \
	--data-binary @- <<EOF
{
  "branchId": "$BRANCH_ID",
  "sql": "INSERT INTO lix_key_value (key, value) VALUES (\$1, \$2)",
  "params": [
    { "kind": "text", "value": "smoke" },
    { "kind": "text", "value": "ok" }
  ]
}
EOF

curl -i -X POST https://api.lixray.com/v1/execute \
	-H "Authorization: Bearer $TOKEN" \
	-H "content-type: application/json" \
	--data-binary @- <<EOF
{
  "branchId": "$BRANCH_ID",
  "sql": "SELECT value FROM lix_key_value WHERE key = \$1",
  "params": [{ "kind": "text", "value": "smoke" }]
}
EOF

curl -i -N -X POST https://api.lixray.com/v1/observe \
	-H "Authorization: Bearer $TOKEN" \
	-H "content-type: application/json" \
	--data-binary @- <<EOF
{
  "branchId": "$BRANCH_ID",
  "sql": "SELECT value FROM lix_key_value WHERE key = \$1",
  "params": [{ "kind": "text", "value": "smoke" }]
}
EOF
```

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

BRANCH_ID="$(curl -fsS http://127.0.0.1:8787/v1/branches \
	-H "Authorization: Bearer $TOKEN" \
	| jq -r '.branches[] | select(.name == "main") | .id')"

curl -i -X POST http://127.0.0.1:8787/v1/execute \
	-H "Authorization: Bearer $TOKEN" \
	-H "content-type: application/json" \
	--data-binary "{\"branchId\":\"$BRANCH_ID\",\"sql\":\"SELECT 1 AS ok\"}"
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

- Project root: `/` when connected to the `lixray` repository, or
  `submodule/lixray` when connected through the parent `flashtype` repository
- Production branch: `main`
- Build command: `pnpm run check:cloudflare`
- Deploy command: `pnpm run deploy:worker`
- Worker name: `lixray`

Enable Workers Builds build caching. The Dockerfile uses BuildKit cache mounts
for the Cargo registry, git checkouts, and target directory; without Cloudflare's
build cache enabled, every deployment recompiles the Lix/DataFusion dependency
graph from scratch.

Do not run `cargo test` in the Workers Builds build command. `wrangler deploy`
builds the container image and compiles the Rust release binary, so running the
full `pnpm check` first causes two Rust compiles in the same Cloudflare build and
can exceed the 20 minute Workers Builds timeout.

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

R2 S3 credentials are created in the Cloudflare dashboard under R2 API tokens.
Use an account token with Object Read & Write access scoped to the `lixray`
bucket.
