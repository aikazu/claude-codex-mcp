#!/usr/bin/env sh
# claude-codex-mcp installer for macOS / Linux.
#
#   ./scripts/install.sh [--uninstall] [--dry-run] [--asset-dir DIR] [--sandbox read-only]
#
# Thin wrapper around scripts/register.mjs.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required (https://nodejs.org). Install it and rerun." >&2
  exit 1
fi

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/register.mjs" "$@"
