#!/bin/bash
# Double-click this file to start Shipyard. No terminal commands needed.
# It installs what's missing the first time, builds the site, starts the local
# server, and opens your browser. Close this window to stop it.

cd "$(dirname "$0")" || exit 1

printf '\n  Shipyard\n  %s\n\n' "$(pwd)"

if ! command -v node >/dev/null 2>&1; then
  cat <<'MSG'
  Node.js isn't installed yet. Shipyard needs it to run.

  Get it here: https://nodejs.org  (choose the LTS download)
  Install it, then double-click this file again.

MSG
  read -r -p "  Press return to close. " _
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '  Node %s is too old. Install the LTS version from https://nodejs.org and try again.\n\n' "$(node -v)"
  read -r -p "  Press return to close. " _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run, installing what Shipyard needs. This takes a minute."
  if ! npm install --no-audit --no-fund --loglevel=error; then
    printf '\n  That install failed. Check your internet connection and try again.\n\n'
    read -r -p "  Press return to close. " _
    exit 1
  fi
fi

echo "  Building the site…"
if ! node scripts/build-site.mjs all; then
  printf '\n  The build failed. The error above says why.\n\n'
  read -r -p "  Press return to close. " _
  exit 1
fi

PORT="${PORT:-4173}"
node scripts/serve.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
sleep 1

open "http://localhost:${PORT}/panel.html" 2>/dev/null

cat <<MSG

  Shipyard is running.

    Control panel   http://localhost:${PORT}/panel.html
    Your apps       http://localhost:${PORT}/launcher.html

  Leave this window open while you work.
  Close it, or press control-C, to stop.

MSG

wait $SERVER_PID
