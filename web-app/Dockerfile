# syntax=docker/dockerfile:1

FROM node:22-bookworm AS builder

ARG LIX_REV=18e7f922bb77271fbd99290e13c6bfec8f1c4c7b
ARG LIX_ARCHIVE_SHA256=6fcff1fa1eabc10aada2ef88f82c146a847ddb82c655b4deb44e1eccc89fee10
ARG ATELIER_REV=127e5526fb3958e97d35c8bd898b0831d0c13079
ARG ATELIER_ARCHIVE_SHA256=78d4be518bb85cbb6ec5f3ff2d716f0a01c46496b9f5b9da20faa5b186eba0a9
ARG LIXRAY_DEMO=1
ARG VITE_LIXRAY_DEMO=1
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_KEY
ARG VITE_LIXRAY_LOCAL_DEV
ARG VITE_LIXRAY_LOCAL_DEV_EMAIL
ARG VITE_LIXRAY_LOCAL_DEV_PASSWORD

WORKDIR /app
ENV LIXRAY_SKIP_VENDORED_LIX_WASM=1 \
	LIXRAY_DEMO=${LIXRAY_DEMO} \
	VITE_LIXRAY_DEMO=${VITE_LIXRAY_DEMO} \
	VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
	VITE_SUPABASE_KEY=${VITE_SUPABASE_KEY} \
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
RUN pnpm --dir web-app build:node

FROM node:22-bookworm-slim AS runtime
ARG LIXRAY_DEMO=1
ARG LIXRAY_DEMO_WORKSPACE_IDS=00000000-0000-4000-8000-000000000002,00000000-0000-4000-8000-000000000003
WORKDIR /app/web-app
COPY --from=builder /app/web-app/dist ./dist
COPY --from=builder /app/web-app/scripts/start-railway.mjs ./scripts/start-railway.mjs

ENV PORT=8080 \
	LIXRAY_DEMO=${LIXRAY_DEMO} \
	LIXRAY_DEMO_WORKSPACE_IDS=${LIXRAY_DEMO_WORKSPACE_IDS}
EXPOSE 8080
CMD ["node", "scripts/start-railway.mjs"]
