# Build image for Anthropic's OSS Scanner.
#
# Everything the project needs is fetched and compiled while this image is
# built, so the scanner can analyse it afterwards with no internet access.
# The crate sources stay in the image under CARGO_HOME, and the compiled
# output stays under /src/target.
#
# Build from the repository root:
#   docker build -f .oss-scanner/Dockerfile .
FROM rust:1-slim-bookworm

ENV CARGO_TERM_COLOR=never \
    CARGO_NET_RETRY=5

# Build tools some crates look for. Installed here, not at analysis time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# Download every dependency named in Cargo.lock, then build the release
# binary and the test targets from that local copy. --locked keeps the
# build on the exact versions the project ships with.
RUN cargo fetch --locked \
    && cargo build --release --locked \
    && cargo test --no-run --locked
