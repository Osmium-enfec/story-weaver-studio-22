#!/usr/bin/env bash
# Import .data/ from an export archive (sync-data-export.sh).
# Usage:
#   npm run data:import
#     → auto-finds story-weaver-data-import.zip or .tar.gz in project root
#   npm run data:import -- path/to/archive.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.data"

find_default_archive() {
  for name in \
    "story-weaver-data-import.zip" \
    "story-weaver-data-import.tar.gz" \
    "story-weaver-data-import.tgz"; do
    if [[ -f "$ROOT/$name" ]]; then
      echo "$ROOT/$name"
      return 0
    fi
  done
  return 1
}

if [[ $# -ge 1 ]]; then
  ARCHIVE="$1"
else
  if ! ARCHIVE="$(find_default_archive)"; then
    echo "No import archive found in project root."
    echo ""
    echo "Place one of these files in the repo root, then run again:"
    echo "  story-weaver-data-import.zip"
    echo "  story-weaver-data-import.tar.gz"
    echo ""
    echo "Or pass a path: npm run data:import -- /path/to/archive.zip"
    exit 1
  fi
  echo "Using: $ARCHIVE"
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive not found: $ARCHIVE"
  exit 1
fi

if [[ -d "$DATA" ]]; then
  BACKUP="$ROOT/.data-backup-$(date +%Y%m%d-%H%M%S)"
  echo "Backing up existing .data to: $BACKUP"
  mv "$DATA" "$BACKUP"
fi

echo "Extracting into: $ROOT"
case "$ARCHIVE" in
  *.zip)
    unzip -q "$ARCHIVE" -d "$ROOT"
    ;;
  *.tar.gz|*.tgz)
    tar -xzf "$ARCHIVE" -C "$ROOT"
    ;;
  *)
    echo "Unsupported archive (use .zip, .tar.gz, or .tgz): $ARCHIVE"
    exit 1
    ;;
esac

if [[ ! -f "$DATA/projects.db" ]]; then
  echo "Warning: projects.db missing after import — check the archive."
  exit 1
fi

echo ""
echo "Import complete."
echo "  projects.db:  $DATA/projects.db"
echo "  app.db:       $DATA/app.db"
echo "  assets:       $DATA/project-assets/"
echo ""
echo "Next: copy .env from your Mac (API keys), then run: npm run dev"
