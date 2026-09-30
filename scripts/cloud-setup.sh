#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rave_runtime="$(realpath -m "${RAVE_RUNTIME_DIR:-../rave-runtime}")"
mkdir -p "$rave_runtime/native" "$rave_runtime/apt/lists/partial" "$rave_runtime/apt/cache/archives/partial" "$rave_runtime/packages"
node -e 'if(process.versions.node!=="24.19.0")throw new Error("Este lockfile requiere Node 24.19.0")'
if ! command -v pnpm >/dev/null || [ "$(pnpm --version)" != '11.19.0' ]; then
  npm install --global --prefix "$rave_runtime/tools" pnpm@11.19.0
  export PATH="$rave_runtime/tools/bin:$PATH"
fi
export RAVE_PG_BIN="$rave_runtime/native/usr/lib/postgresql/17/bin"
if [ ! -x "$RAVE_PG_BIN/postgres" ] || [ ! -x "$rave_runtime/native/usr/bin/age" ]; then
  test -r /usr/share/keyrings/debian-archive-keyring.gpg
  cat > "$rave_runtime/apt/sources.list" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main
SOURCES
  rave_apt=(-o "Dir::State::lists=$rave_runtime/apt/lists" -o "Dir::Cache=$rave_runtime/apt/cache" -o "Dir::Etc::sourcelist=$rave_runtime/apt/sources.list" -o 'Dir::Etc::sourceparts=-' -o "APT::Sandbox::User=$(id -un)" -o 'Acquire::Retries=3')
  apt-get "${rave_apt[@]}" update
  (cd "$rave_runtime/packages"; apt-get "${rave_apt[@]}" download postgresql-17=17.11-0+deb13u1 postgresql-client-17=17.11-0+deb13u1 age=1.2.1-1+b5)
  for rave_deb in "$rave_runtime/packages/"*.deb; do dpkg-deb -x "$rave_deb" "$rave_runtime/native"; done
fi
"$RAVE_PG_BIN/postgres" --version
"$rave_runtime/native/usr/bin/age" --version
ffmpeg -hide_banner -version | head -n 1
ffprobe -hide_banner -version | head -n 1
command -v chromium >/dev/null
export RAVE_RUNTIME_ROOT="$rave_runtime/state"
export RAVE_AGE_BIN="$rave_runtime/native/usr/bin/age"
pnpm install --frozen-lockfile
pnpm local:prepare
pnpm local:db
pnpm db:migrate
pnpm bootstrap
pnpm env:check
if [ "${1:-}" != '--dependencies-only' ]; then pnpm build; fi
