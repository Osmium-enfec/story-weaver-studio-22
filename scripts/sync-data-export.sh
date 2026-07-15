#!/usr/bin/env bash
# Export .data/ (SQLite DBs + assets) for transfer to another machine.
# Usage: ./scripts/sync-data-export.sh [output-file]
# Default output: story-weaver-data-import.zip in project root (drop-in for import)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.data"
OUT="${1:-$ROOT/story-weaver-data-import.zip}"

if [[ ! -d "$DATA" ]]; then
  echo "No .data folder found at $DATA"
  exit 1
fi

checkpoint_db() {
  local db="$1"
  if [[ ! -f "$db" ]]; then
    return 0
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "Warning: sqlite3 not found — stop the dev server before copying for a safe export."
    return 0
  fi
  echo "Checkpointing $(basename "$db")..."
  sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);"
}

echo "Exporting host data from: $DATA"
checkpoint_db "$DATA/projects.db"
checkpoint_db "$DATA/app.db"

case "$OUT" in
  *.zip)
    rm -f "$OUT"
    (cd "$ROOT" && zip -rq "$OUT" .data)
    ;;
  *.tar.gz|*.tgz)
    tar -czf "$OUT" -C "$ROOT" .data
    ;;
  *)
    echo "Output must end with .zip, .tar.gz, or .tgz"
    exit 1
    ;;
esac

echo ""
echo "Created: $OUT"
echo "Size:    $(du -sh "$OUT" | cut -f1)"
echo ""
echo "On the other machine:"
echo "  1. git clone && npm install"
echo "  2. Copy this file into the repo root as: story-weaver-data-import.zip"
echo "  3. npm run data:import"
echo "  4. Copy .env from this Mac, then npm run dev"
