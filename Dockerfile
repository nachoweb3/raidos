# RaidOS Trading API — Docker image (used by Railway, also works on any Docker host)
#
# Builds packages/app (a standalone pnpm package) and runs the API server.
# Mirrors the previous Render buildCommand:
#   cd packages/app && corepack enable && pnpm install && pnpm build
#
# Runtime env vars (set in the host dashboard):
#   DB_PATH          SQLite file path, e.g. /data/raidos.db (persistent volume)
#   APP_MODE         "live" (real chain txs) | "mock" (labeled simulation, default)
#   BOOTSTRAP_SECRET secret required to register users after the first one
#   PORT             injected by the platform; server defaults to 8787

FROM node:22-bookworm-slim

# better-sqlite3 needs a source build fallback if no prebuilt binary matches
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Install deps first (cache-friendly layer) — manifests + lockfile only
COPY packages/app/package.json packages/app/pnpm-lock.yaml packages/app/pnpm-workspace.yaml packages/app/.npmrc packages/app/
RUN cd packages/app && pnpm install --frozen-lockfile

# Build
COPY packages/app/src packages/app/src
COPY packages/app/tsconfig.json packages/app/
RUN cd packages/app && pnpm build

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "packages/app/dist/api/main.js"]