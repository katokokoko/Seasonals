# syntax=docker/dockerfile:1
#
# Seasonals BFF — 公開用 image (Fly.io `api.seasonals.cafe`、docs/external-release-api-handling.md §3)
#
# build context は **repo root** (lib/ と pnpm workspace の lockfile が要るため)。repo root で:
#   fly deploy --config artifacts/seasonals-bff/fly.toml --build-arg GIT_SHA=$(git rev-parse --short HEAD)
# fly は fly.toml の ignorefile (artifacts/seasonals-bff/.dockerignore) で context を絞る。
# docker CLI 単体で build する時は context root の .dockerignore しか読まれないので、
# 同じ内容を渡すこと (.env / .data / node_modules を context に入れない)。
#
# BFF は tsx (esbuild) で .ts を直接実行する (package.json "start")。compile step は無い。

# ── base: Node + pnpm (repo の packageManager と同じ版) ───────────────────────
FROM node:24-slim AS base
RUN npm install -g pnpm@10.33.4
WORKDIR /app

# ── deps: 本番依存だけを install ─────────────────────────────────────────────
# lockfile は全 workspace の importer を含むので、frozen install には全 package.json が要る
# (中身の source は不要)。--filter @seasonals/bff... = BFF とその workspace 依存 (lib)。
# .npmrc の node-linker=hoisted により依存は /app/node_modules に平置きされ、
# artifacts/seasonals-bff/node_modules/@workspace/lib → /app/lib の symlink が張られる。
# tsx は package.json の dependencies (devDependencies ではない) にあるので --prod でも入る。
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY lib/package.json lib/
COPY artifacts/seasonals-bff/package.json artifacts/seasonals-bff/
COPY artifacts/seasonals/package.json artifacts/seasonals/
COPY artifacts/seasonals-web/package.json artifacts/seasonals-web/
COPY artifacts/seasonals-mcp-server/package.json artifacts/seasonals-mcp-server/
RUN pnpm install --frozen-lockfile --prod --filter @seasonals/bff...

# ── runtime: node_modules + lib + BFF の src だけ ──────────────────────────────
# tsconfig.base.json (paths: @workspace/lib/*) は deps stage の /app から一緒に来る。
# .dockerignore が *.test.ts / .env / .data を context から落とす。
FROM base AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3030 SEASONALS_DATA_DIR=/data GIT_SHA=$GIT_SHA
COPY --from=deps /app ./
COPY lib ./lib
COPY artifacts/seasonals-bff/src ./artifacts/seasonals-bff/src
COPY artifacts/seasonals-bff/tsconfig.json ./artifacts/seasonals-bff/
COPY artifacts/seasonals-bff/docker-entrypoint.sh /usr/local/bin/seasonals-entrypoint
# /app は read-only で動くので chown しない (node_modules を丸ごと複製する layer を作らない)。
# /data は Fly volume の mount 先。mount は root 所有で image 側の所有権を隠すため、
# entrypoint が起動時に node へ渡してから権限を落とす (docker-entrypoint.sh)。
RUN mkdir -p /data && chown node:node /data
EXPOSE 3030
WORKDIR /app/artifacts/seasonals-bff
ENTRYPOINT ["/bin/sh", "/usr/local/bin/seasonals-entrypoint"]
# pnpm を挟まず tsx を直接起動する (= `pnpm start`)。tsx は SIGINT / SIGTERM を子へ中継する
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
