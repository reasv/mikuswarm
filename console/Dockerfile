# syntax=docker/dockerfile:1.7
#
# Miku observability console — a SvelteKit BFF (adapter-node) that proxies the
# agent's in-process read API (see ../ARCHITECTURE.md §11 and README.md). Built
# independently of the agent; this is its own pnpm workspace.
#
# Build context is ./console (see docker-compose.yml).

# -----------------------------------------------------------------------------
# Builder — install deps + vite build → /app/build
# -----------------------------------------------------------------------------
FROM node:24-trixie AS builder

# The console's only native-ish devDep is playwright (vitest browser tests). We
# never run those here, so skip its multi-hundred-MB browser download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# -----------------------------------------------------------------------------
# Runtime — node serving the adapter-node output
# -----------------------------------------------------------------------------
FROM node:24-trixie-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5173
WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 5173
CMD ["node", "build/index.js"]
