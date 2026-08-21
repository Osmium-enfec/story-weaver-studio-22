#!/bin/bash
# Keep LAN-stable Studio on :8080 for local LAN + deskos (other networks).
# deskos tunnel → :3000 proxy → this process on :8080.
set -euo pipefail

ROOT="/Users/enfecsolutions/Enfec Content/divStudio-lan-stable"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$ROOT"

# Load .env into the environment (Vite also reads it; this helps native deps).
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

exec /opt/homebrew/bin/node ./node_modules/.bin/vite dev \
  --host 0.0.0.0 \
  --port 8080 \
  --strictPort
