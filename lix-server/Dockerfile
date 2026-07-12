# syntax=docker/dockerfile:1

ARG LIXRAY_IMAGE_VARIANT=preview

FROM rust:1-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/usr/local/cargo/git \
	--mount=type=cache,target=/app/target \
	cargo build --release --locked \
	&& mkdir -p /app/dist \
	&& cp /app/target/release/lixray /app/dist/lixray

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
