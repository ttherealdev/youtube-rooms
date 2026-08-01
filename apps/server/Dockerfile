# syntax=docker/dockerfile:1.7
#
# Three stages (ADR 0012):
#   1. planner  — compute the dependency graph only
#   2. builder  — build dependencies (cached), then the app
#   3. runtime  — distroless, non-root, ~25 MB
#
# The cargo-chef split is what makes a code-only change rebuild in seconds
# instead of recompiling every crate in the tree.

# --- 1. Plan -----------------------------------------------------------------
FROM rust:1.97-bookworm AS planner
WORKDIR /build
RUN cargo install cargo-chef --locked --version ^0.1
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo chef prepare --recipe-path recipe.json

# --- 2. Build ----------------------------------------------------------------
FROM rust:1.97-bookworm AS builder
WORKDIR /build

RUN cargo install cargo-chef --locked --version ^0.1

# Dependencies first, as their own layer.
COPY --from=planner /build/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations

# No database is reachable at build time. Queries are runtime-bound
# (see ADR 0003), and this makes that explicit rather than accidental.
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked --bin playercn-server \
 && strip target/release/playercn-server

# --- 3. Run ------------------------------------------------------------------
# `cc` rather than `static`: the binary links libgcc and libc through ring.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

WORKDIR /app
COPY --from=builder /build/target/release/playercn-server /app/playercn-server
# Migrations are applied at boot, so they must ship with the binary.
COPY --from=builder /build/migrations /app/migrations

ENV BIND_ADDR=0.0.0.0:8080 \
    RUST_BACKTRACE=1
EXPOSE 8080

# Distroless has no shell, so the health check must be an exec-form command.
# The binary answers `--health-check` by probing its own readiness endpoint.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/app/playercn-server", "--health-check"]

# `nonroot` (uid 65532) is baked into the base image; never run as root.
USER nonroot:nonroot

LABEL org.opencontainers.image.title="playercn-server" \
      org.opencontainers.image.description="Authoritative realtime service for playercn" \
      org.opencontainers.image.source="https://github.com/your-org/playercn" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/app/playercn-server"]
