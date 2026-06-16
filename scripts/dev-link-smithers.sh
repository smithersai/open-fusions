#!/usr/bin/env bash
# Dev-only: point open-fusions at the local smithers 0.24.0 monorepo build
# until the new smithers-orchestrator version is published to npm.
# After publish: delete these symlinks and `bun install` the published version.
set -euo pipefail
MROOT="${SMITHERS_REPO:-/Users/williamcory/smithers}"
OF="$(cd "$(dirname "$0")/.." && pwd)"
cd "$OF/node_modules"
rm -rf smithers-orchestrator @smithers-orchestrator effect
ln -s "$MROOT/packages/smithers" smithers-orchestrator
ln -s "$MROOT/node_modules/@smithers-orchestrator" @smithers-orchestrator
ln -s "$MROOT/node_modules/effect" effect
echo "Linked smithers-orchestrator -> $MROOT/packages/smithers (local 0.24.0)"
