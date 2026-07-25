# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .


# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN addgroup -S glasschat && adduser -S glasschat -G glasschat

WORKDIR /app

COPY --from=builder --chown=glasschat:glasschat /app/node_modules ./node_modules
COPY --from=builder --chown=glasschat:glasschat /app/server.js ./server.js
COPY --from=builder --chown=glasschat:glasschat /app/package.json ./package.json
COPY --from=builder --chown=glasschat:glasschat /app/public ./public

RUN mkdir -p /app/data && chown glasschat:glasschat /app/data

USER glasschat

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
