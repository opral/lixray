# syntax=docker/dockerfile:1

ARG LIXRAY_IMAGE_VARIANT=production

FROM rust:1-bookworm AS builder
ARG LIX_REV=e3f5224e965f72a68d3a9f0b516732ee7da96b05
ARG LIX_ARCHIVE_SHA256=0122b22083a4f58f964fd969e3012ef2dd7078d67565c09bbbd9776197dde79d
WORKDIR /app

# This Dockerfile uses the repository root as its build context so the server
# and its vendored Lix checkout are built together. Railway's GitHub builder
# does not populate submodules, so an empty checkout falls back to the exact
# pinned revision rather than silently building a different version. Web-app
# changes also deploy this service so focused PR environments remain usable.
COPY vendor/lix ./vendor/lix
RUN if [ ! -f vendor/lix/packages/engine/Cargo.toml ]; then \
		curl -fsSL "https://github.com/opral/lix/archive/${LIX_REV}.tar.gz" -o /tmp/lix.tar.gz; \
		echo "${LIX_ARCHIVE_SHA256}  /tmp/lix.tar.gz" | sha256sum -c -; \
		tar -xzf /tmp/lix.tar.gz -C vendor/lix --strip-components=1; \
		rm /tmp/lix.tar.gz; \
	fi
COPY lix-server/Cargo.toml lix-server/Cargo.lock ./lix-server/
COPY lix-server/src ./lix-server/src

WORKDIR /app/lix-server
# Railway requires cache IDs to be namespaced by the service ID. Docker treats
# these as opaque cache keys, so the same mounts also work for local builds.
RUN --mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
	--mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/usr/local/cargo/git,target=/usr/local/cargo/git \
	--mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/app/lix-server/target,target=/app/lix-server/target \
	cargo clean --release --package lixray \
	&& cargo build --release --locked \
	&& mkdir -p /app/dist \
	&& cp /app/lix-server/target/release/lixray /app/dist/lixray

FROM debian:bookworm-slim AS runtime
ARG LIXRAY_IMAGE_VARIANT
LABEL com.lixray.image-variant=${LIXRAY_IMAGE_VARIANT}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist/lixray /usr/local/bin/lixray

EXPOSE 8080
CMD ["/usr/local/bin/lixray"]
