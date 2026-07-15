#!/usr/bin/env bash
# Build all extension bundles and produce a store-ready zip.
set -euo pipefail
cd "$(dirname "$0")/.."

npx esbuild src/popup.js      --bundle --minify --outfile=ext/popup.bundle.js
npx esbuild src/content.js    --bundle --minify --outfile=ext/content.bundle.js
npx esbuild src/background.js --bundle --minify --outfile=ext/background.bundle.js
npx esbuild src/offscreen.js  --bundle --minify --outfile=ext/offscreen.bundle.js

rm -rf dist && mkdir -p dist/md2epub
cp -r ext/* dist/md2epub/
( cd dist && zip -rq md2epub.zip md2epub )
echo "Built dist/md2epub.zip"
