#!/usr/bin/env bash
# Build a clean ZIP of extension/ for Chrome Web Store submission.
# Only ships files Chrome needs to run the extension.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./extension/manifest.json').version")
OUTPUT_DIR="$REPO_ROOT/dist"
OUTPUT="$OUTPUT_DIR/bonsai-feed-filter-v${VERSION}.zip"

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT"

cd "$REPO_ROOT/extension"
zip -r "$OUTPUT" . \
  -x "*.DS_Store" \
  -x "*/.DS_Store" \
  -x "globals.d.ts" \
  -x "*.map" \
  -x "icons/bonsai.svg"

echo
echo "Packaged: $OUTPUT"
du -h "$OUTPUT" | cut -f1 | xargs -I{} echo "Size: {}"
echo
echo "Contents:"
unzip -l "$OUTPUT"
