# syntax=docker/dockerfile:1

FROM node:22-bookworm AS builder

ARG LIX_REV=3caa9534f27b22c94e519b526c837f0def6415dd
ARG LIX_ARCHIVE_SHA256=aa91d6e47df61a10866cad7aad953a8157fbfbc27b2e9e541fe4bc434790e3ed
ARG ATELIER_REV=1ff102f2d2659e5f4e01bff4d8cbe9ae0f6f687f
ARG ATELIER_ARCHIVE_SHA256=493572f99c719670eaf42866ad2c784cd481219b8cf53d6898b8c704f5aaea2e
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_KEY
ARG LIXRAY_DEMO
ARG LIXRAY_DEMO_WORKSPACE_IDS
ARG VITE_LIXRAY_DEMO
ARG VITE_PUBLIC_POSTHOG_TOKEN
ARG VITE_PUBLIC_POSTHOG_HOST
ARG VITE_PUBLIC_TELEMETRY_ENVIRONMENT
ARG VITE_LIXRAY_LOCAL_DEV
ARG VITE_LIXRAY_LOCAL_DEV_EMAIL
ARG VITE_LIXRAY_LOCAL_DEV_PASSWORD

WORKDIR /app
ENV LIXRAY_SKIP_VENDORED_LIX_WASM=1 \
	VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
	VITE_SUPABASE_KEY=${VITE_SUPABASE_KEY} \
	LIXRAY_DEMO=${LIXRAY_DEMO} \
	LIXRAY_DEMO_WORKSPACE_IDS=${LIXRAY_DEMO_WORKSPACE_IDS} \
	VITE_LIXRAY_DEMO=${VITE_LIXRAY_DEMO} \
	VITE_PUBLIC_POSTHOG_TOKEN=${VITE_PUBLIC_POSTHOG_TOKEN} \
	VITE_PUBLIC_POSTHOG_HOST=${VITE_PUBLIC_POSTHOG_HOST} \
	VITE_PUBLIC_TELEMETRY_ENVIRONMENT=${VITE_PUBLIC_TELEMETRY_ENVIRONMENT} \
	VITE_LIXRAY_LOCAL_DEV=${VITE_LIXRAY_LOCAL_DEV} \
	VITE_LIXRAY_LOCAL_DEV_EMAIL=${VITE_LIXRAY_LOCAL_DEV_EMAIL} \
	VITE_LIXRAY_LOCAL_DEV_PASSWORD=${VITE_LIXRAY_LOCAL_DEV_PASSWORD}
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY . .

# Railway's GitHub builder does not populate submodules. Local builds retain
# the checked-out sources so edits are tested directly; Railway falls back to
# the exact revisions recorded by this repository.
RUN if [ ! -f vendor/lix/packages/js-sdk/package.json ]; then \
		curl -fsSL "https://github.com/opral/lix/archive/${LIX_REV}.tar.gz" -o /tmp/lix.tar.gz; \
		echo "${LIX_ARCHIVE_SHA256}  /tmp/lix.tar.gz" | sha256sum -c -; \
		tar -xzf /tmp/lix.tar.gz -C vendor/lix --strip-components=1; \
		rm /tmp/lix.tar.gz; \
	fi \
	&& if [ ! -f vendor/atelier/package.json ]; then \
		curl -fsSL "https://github.com/opral/atelier/archive/${ATELIER_REV}.tar.gz" -o /tmp/atelier.tar.gz; \
		echo "${ATELIER_ARCHIVE_SHA256}  /tmp/atelier.tar.gz" | sha256sum -c -; \
		tar -xzf /tmp/atelier.tar.gz -C vendor/atelier --strip-components=1; \
		rm /tmp/atelier.tar.gz; \
	fi

# Railway cache mounts must be namespaced by this service's ID. Docker treats
# the ID as opaque, so the same cache works for local Compose builds.
RUN --mount=type=cache,id=s/c745bcb2-fef1-4ba6-9ebf-a6d112d94d05-/root/.local/share/pnpm/store,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile
RUN test -n "$VITE_SUPABASE_URL" \
	&& test -n "$VITE_SUPABASE_KEY" \
	&& pnpm --dir web-app build:node

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/web-app
COPY --from=builder /app/web-app/dist ./dist
COPY --from=builder /app/web-app/scripts/assert-railway-env.mjs ./scripts/assert-railway-env.mjs
COPY --from=builder /app/web-app/scripts/start-railway.mjs ./scripts/start-railway.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["node", "scripts/start-railway.mjs"]
