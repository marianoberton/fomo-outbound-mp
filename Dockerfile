# syntax=docker/dockerfile:1.7
# Multi-stage build para outbound-mp.
#
# El cron del workflow solo funciona si el proceso queda vivo entre ticks — usar
# siempre un host long-lived (Fly Machines, Railway, ECS, etc.). Nunca FaaS
# (Lambda, Vercel, Cloudflare Workers): el setInterval del scheduler se pierde.

# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Necesitamos las dev deps para `mastra build`.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# `mastra build` produce un bundle self-contained en .mastra/output/ con su
# propio package.json + node_modules. No hace falta copiar src/ ni deps al runtime.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# wget — busybox-wget viene preinstalado y es suficiente para el HEALTHCHECK.

COPY --from=builder /app/.mastra/output ./

ENV NODE_ENV=production \
    PORT=4111 \
    LOG_LEVEL=info

EXPOSE 4111

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "index.mjs"]
