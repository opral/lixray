# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.8.0 AS xx

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS builder
COPY --from=xx / /

RUN apt-get update \
	&& apt-get install -y --no-install-recommends clang file lld \
	&& rm -rf /var/lib/apt/lists/*

ARG TARGETPLATFORM
RUN xx-apt-get install -y binutils gcc libc6-dev

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/usr/local/cargo/git \
	--mount=type=cache,id=lixray-target-${TARGETPLATFORM},target=/app/target \
	xx-cargo build --release --locked --target-dir /app/target \
	&& mkdir -p /app/dist \
	&& cp "/app/target/$(xx-cargo --print-target-triple)/release/lixray" /app/dist/lixray \
	&& xx-verify /app/dist/lixray

FROM debian:bookworm-slim AS runtime
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /app/dist/lixray /usr/local/bin/lixray

EXPOSE 8080
CMD ["/usr/local/bin/lixray"]
