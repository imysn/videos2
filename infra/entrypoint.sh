#!/bin/sh
set -eu
case "${1:-api}" in
  api) node dist/apps/api/src/bootstrap.js; exec node dist/apps/api/src/main.js ;;
  worker) exec node dist/apps/worker/src/main.js ;;
  backup) exec node dist/scripts/backup.js ;;
  *) exec "$@" ;;
esac
