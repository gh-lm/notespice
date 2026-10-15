# ---- Build stage: compile the release binary ----
FROM rust:1-slim-bookworm AS build
WORKDIR /app

# libssl/pkg-config aren't strictly required by this dependency set today,
# but kept here so adding a TLS-using crate later doesn't silently break
# the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

# ---- Final stage: only the runtime ----
FROM debian:bookworm-slim
WORKDIR /app

# Where the source for this image lives, so tools that read image
# labels can point people at it.
LABEL org.opencontainers.image.source="https://github.com/gh-lm/notespice"
LABEL org.opencontainers.image.url="https://notespice.org"
LABEL org.opencontainers.image.description="Notespice - self-hosted, database-less markdown notes"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"

# Patch OS packages at build time rather than trusting whatever was
# baked into the base image when it was last published. curl is added
# solely so HEALTHCHECK below has something to probe with.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Reuse a fixed, non-root UID/GID (1000) rather than root. debian-slim
# has no built-in non-root user the way node:alpine does, so we create
# one explicitly.
RUN groupadd -g 1000 notes && useradd -u 1000 -g notes -M -s /usr/sbin/nologin notes

COPY --from=build /app/target/release/notespice ./notespice
COPY static ./static

RUN mkdir -p /notes /data && chown -R notes:notes /app /notes /data
USER notes

ENV NOTES_DIR=/notes
ENV NOTES_DATA_DIR=/data
ENV NOTES_PORT=8080
EXPOSE 8080
VOLUME ["/notes", "/data"]

# Hits the static index page rather than an /api/ route, since that's
# served with no auth check either way - a plain 200 here just confirms
# the server is up and accepting connections, nothing more.
HEALTHCHECK --interval=120s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${NOTES_PORT}/" || exit 1

CMD ["./notespice"]
