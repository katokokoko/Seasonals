#!/bin/sh
# Seasonals BFF container entrypoint (Dockerfile の ENTRYPOINT)。
#
# Fly volume は新規 ext4 で root 所有のまま mount され、image 側で chown した /data を隠す。
# root で起動した時だけ data dir を node user に渡し、BFF 本体は権限を落として exec する。
# setpriv は util-linux (Debian の essential package) に含まれる。
# root 以外で起動された時 (docker run --user 等) はそのまま exec する。
set -eu

DATA_DIR="${SEASONALS_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node "$@"
fi

exec "$@"
