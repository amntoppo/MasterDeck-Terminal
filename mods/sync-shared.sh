#!/bin/bash
# Copy mods/shared/deck.ts into every MasterDeck mod as hooks/deck.ts (a mod may import only its
# own files). app/src/shared/modsShared.test.ts fails while a copy differs.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
for m in masterdeck masterdeck-ticket masterdeck-alerts masterdeck-note masterdeck-loop masterdeck-board; do
  cp "$here/shared/deck.ts" "$here/$m/hooks/deck.ts"
done
echo "copied shared/deck.ts into 6 mods"
