# syntax=docker/dockerfile:1

FROM node:22-bookworm AS builder

ARG LIX_REV=3b1421ae8e86b2b30ad3cc2f916296a6ca9aea1a
ARG LIX_ARCHIVE_SHA256=ab74cd0ada12d4e481ded1f4436fa4f49a7cbee3b1ad574c29f748c10624d6ba
ARG ATELIER_REV=c0c63851b48dd3ffad660800eab9fe80b3b56404
ARG ATELIER_ARCHIVE_SHA256=c95961ded1ef1dafdaf1ca37e711e5d66d53775775e9395cb312c590292ec1f4

WORKDIR /app
ENV LIXRAY_SKIP_VENDORED_LIX_WASM=1
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

RUN pnpm install --frozen-lockfile
RUN pnpm --dir web-app build:railway

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/web-app
COPY --from=builder /app/web-app/dist ./dist
COPY --from=builder /app/web-app/scripts/start-railway.mjs ./scripts/start-railway.mjs

ENV PORT=8080 \
	LIXRAY_DEMO=1 \
	LIXRAY_DEMO_WORKSPACE_IDS=00000000-0000-4000-8000-000000000002,00000000-0000-4000-8000-000000000003
EXPOSE 8080
CMD ["node", "scripts/start-railway.mjs"]
