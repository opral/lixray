# syntax=docker/dockerfile:1

ARG LIXRAY_IMAGE_VARIANT=production

FROM rust:1-bookworm AS builder
ARG CARGO_BUILD_JOBS=2
ARG LIX_REV=cefba26f90ee047f9059041b7032e9d60de0ba90
ARG LIX_ARCHIVE_SHA256=a72b99a309d75c11e64809f5960a981e4f0d06acfe839242f60022e5c184e003
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
	fi \
	&& cp vendor/lix/rust-toolchain.toml ./rust-toolchain.toml
COPY lix-server/Cargo.toml lix-server/Cargo.lock ./lix-server/
COPY lix-server/src ./lix-server/src

WORKDIR /app/lix-server
# Railway requires cache IDs to be namespaced by the service ID. Docker treats
# these as opaque cache keys, so the same mounts also work for local builds.
# The default two compile jobs keep the Wasmtime release build inside
# Railway's memory envelope. Compose overrides it for its high-memory CI
# builder so the local stack is ready within Playwright's startup budget.
RUN --mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
	--mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/usr/local/cargo/git,target=/usr/local/cargo/git \
	--mount=type=cache,id=s/e84e4572-f7b7-4d3e-abb9-bfdc80c23be7-/app/lix-server/target,target=/app/lix-server/target \
	cargo -Z bindeps clean --release --package lixray \
	&& CARGO_BUILD_JOBS="$CARGO_BUILD_JOBS" cargo -Z bindeps build --release --locked \
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
