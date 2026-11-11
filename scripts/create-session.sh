#!/usr/bin/env bash
# Create a separate Kite Passport spending session, or a dry-run placeholder when kpass is absent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec pnpm exec tsx src/cli.ts session create "$@"
