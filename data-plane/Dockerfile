FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/helix-data-plane /usr/local/bin/
ENV DATA_PLANE_BIND=0.0.0.0:9847
EXPOSE 9847
CMD ["helix-data-plane"]
