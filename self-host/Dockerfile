FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY self-host/package.json self-host/package-lock.json ./self-host/
RUN cd self-host && npm ci --omit=dev

COPY worker ./worker
COPY self-host/src ./self-host/src

# Application code and dependencies stay root-owned/read-only. The runtime
# user needs write access only to the persistent state mount.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/self-host

ENV TUBEPULSE_HOST=0.0.0.0 \
    TUBEPULSE_PORT=8788 \
    TUBEPULSE_DATA_DIR=/data \
    MINIFLARE_CACHE_DIR=/data/.miniflare-cache \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/_tubepulse/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/cli.mjs", "serve"]
