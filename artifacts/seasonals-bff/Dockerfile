# syntax=docker/dockerfile:1
#
# Seasonals BFF — 公開用 image (Fly.io `api.seasonals.cafe`、docs/external-release-api-handling.md §3)
#
# build context は **repo root** (lib/ と pnpm workspace の lockfile が要るため)。repo root で:
#   pnpm deploy:bff   (= fly deploy --remote-only。fly.toml の ignorefile で context を絞る)
# 手元で確かめる時 (Docker Desktop / OrbStack、docs/external-release-api-handling.md §9.0):
#   docker build -f artifacts/seasonals-bff/Dockerfile -t seasonals-bff:local .
#   docker run --rm -p 3030:3030 -e SOLANA_EXECUTION_TARGET=disabled -v seasonals-data:/data seasonals-bff:local
# BuildKit は Dockerfile と同じ dir の Dockerfile.dockerignore を自動で読むので fly と同じ除外が効く
# (無いと 2.7GB の node_modules が context に入る)。.env / .data は COPY 対象外だが context にも入れない。
#
# BFF は tsx (esbuild) で .ts を直接実行する (package.json "start")。compile step は無い。

# ── base: Node + pnpm (repo の packageManager と同じ版) ───────────────────────
FROM node:24-slim AS base
RUN npm install -g pnpm@10.33.4
WORKDIR /app

# ── deps: 本番依存だけを install ─────────────────────────────────────────────
# lockfile は全 workspace の importer を含むので、frozen install には全 package.json が要る
# (中身の source は不要)。--filter @seasonals/bff... = BFF とその workspace 依存 (lib)。
# repo の .npmrc は node-linker=hoisted だが、hoisted は --filter を無視して lockfile の全 importer
# (mobile の React Native / Expo / Skia まで) を /app/node_modules に展開し、image が 2.5GB になる。
# この stage だけ isolated linker にして BFF + lib の依存だけを入れる (625MB、2026-10-12 実測)。
# shamefully-hoist は、BFF が package.json に書かずに import している transitive 依存
# (bn.js / bs58 / @orca-so/common-sdk) を /app/node_modules から解決させるため
# (ローカルの hoisted layout と同じ見え方)。
# artifacts/seasonals-bff/node_modules/@workspace/lib → /app/lib の symlink は従来どおり。
# tsx は package.json の dependencies (devDependencies ではない) にあるので --prod でも入る。
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY lib/package.json lib/
COPY artifacts/seasonals-bff/package.json artifacts/seasonals-bff/
COPY artifacts/seasonals/package.json artifacts/seasonals/
COPY artifacts/seasonals-web/package.json artifacts/seasonals-web/
COPY artifacts/seasonals-mcp-server/package.json artifacts/seasonals-mcp-server/
RUN pnpm install --frozen-lockfile --prod --filter @seasonals/bff... \
      --config.node-linker=isolated --config.shamefully-hoist=true

# ── runtime: node_modules + lib + BFF の src だけ ──────────────────────────────
# tsconfig.base.json (paths: @workspace/lib/*) は deps stage の /app から一緒に来る。
# Dockerfile.dockerignore が *.test.ts / .env / .data を context から落とす。
FROM base AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3030 SEASONALS_DATA_DIR=/data GIT_SHA=$GIT_SHA
COPY --from=deps /app ./
COPY lib ./lib
COPY artifacts/seasonals-bff/src ./artifacts/seasonals-bff/src
COPY artifacts/seasonals-bff/tsconfig.json ./artifacts/seasonals-bff/
COPY artifacts/seasonals-bff/docker-entrypoint.sh /usr/local/bin/seasonals-entrypoint
# context から COPY した file は手元の mode をそのまま持ち込む。開発機で 0600 になっていた
# lib/types/enums.ts が node user (entrypoint が権限を落とす) から EACCES で読めず、初回 deploy が
# 起動ループになった (2026-10-12)。source と設定は全部 world-readable に揃える (dir は a+X)。
# node_modules は deps stage で root が umask 022 で書いたものなので触らない (chmod -R は layer を複製する)
RUN chmod -R a+rX /app/lib /app/artifacts && chmod a+r /app/*.json /app/*.yaml /app/.npmrc
# /app は read-only で動くので chown しない (node_modules を丸ごと複製する layer を作らない)。
# /data は Fly volume の mount 先。mount は root 所有で image 側の所有権を隠すため、
# entrypoint が起動時に node へ渡してから権限を落とす (docker-entrypoint.sh)。
RUN mkdir -p /data && chown node:node /data
EXPOSE 3030
WORKDIR /app/artifacts/seasonals-bff
ENTRYPOINT ["/bin/sh", "/usr/local/bin/seasonals-entrypoint"]
# pnpm を挟まず tsx を直接起動する (= `pnpm start`)。tsx は SIGINT / SIGTERM を子へ中継する。
# isolated linker では bin は project 側 (artifacts/seasonals-bff/node_modules/.bin) に入る
CMD ["node_modules/.bin/tsx", "src/index.ts"]
