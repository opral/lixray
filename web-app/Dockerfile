# syntax=docker/dockerfile:1

FROM node:22-bookworm AS builder

ARG LIX_REV=a101736982eaea077cee65bb440afd8995d26650
ARG LIX_ARCHIVE_SHA256=64a5f0c84781d9ce645f947bcbce1d7b66c7905e982a1dffcd656ce28c036bb3
ARG ATELIER_REV=c651e50e36fe8aad84d2ba09165a8f00b354a225
ARG ATELIER_ARCHIVE_SHA256=c6abd1740973dda2a90fb9c624bf53b31cff7fa447a8994aa8b29653c406448a
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
ARG RAILWAY_ENVIRONMENT_NAME

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
	VITE_LIXRAY_LOCAL_DEV_PASSWORD=${VITE_LIXRAY_LOCAL_DEV_PASSWORD} \
	RAILWAY_ENVIRONMENT_NAME=${RAILWAY_ENVIRONMENT_NAME}
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
# Railway names PR environments "lixray-pr-<n>" when configured, but
# recreated ones get the default "pr-<hash>-<n>" — accept both. Keep in
# sync with assert-railway-env.mjs and worker/handler.ts isDemoMode.
RUN if echo "$RAILWAY_ENVIRONMENT_NAME" | grep -Eq '^(lixray-pr-[0-9]+|pr-[a-z0-9]+-[0-9]+)$'; then \
		export LIXRAY_DEMO=1; \
		export LIXRAY_DEMO_WORKSPACE_IDS=00000000-0000-4000-8000-000000000002; \
		export VITE_LIXRAY_DEMO=1; \
	else \
		test -n "$VITE_SUPABASE_URL"; \
		test -n "$VITE_SUPABASE_KEY"; \
	fi \
	&& pnpm --dir web-app build:node

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/web-app
COPY --from=builder /app/web-app/dist ./dist
COPY --from=builder /app/web-app/scripts/assert-railway-env.mjs ./scripts/assert-railway-env.mjs
COPY --from=builder /app/web-app/scripts/start-railway.mjs ./scripts/start-railway.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["node", "scripts/start-railway.mjs"]
