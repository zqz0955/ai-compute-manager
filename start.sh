#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: sh start.sh /absolute/install/config.json' >&2
  exit 2
fi
umask 077
app_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$app_dir/server.mjs" --config "$1"
