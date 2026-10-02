#!/usr/bin/env bash
# Copy the backend's wire contract into MasterDeck (never edit shared/remote.ts by hand).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
backend="${MASTERDECK_BACKEND:-$here/../../masterdeck-backend}"
cp "$backend/src/protocol.ts" "$here/src/shared/remote.ts"
echo "copied $backend/src/protocol.ts → src/shared/remote.ts"
