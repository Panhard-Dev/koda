#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run app:version
npm run app:cloudflare
npm run app:host
npm run app:runtime
npm run app:node
LDAI_COMP=zstd npx tauri build --bundles appimage,deb,rpm \
  --config '{"bundle":{"linux":{"rpm":{"compression":{"type":"zstd","level":3}}}}}'

versao=$(node -p "require('./src-tauri/tauri.conf.json').version")
appimage="src-tauri/target/release/bundle/appimage/Koda_${versao}_amd64.AppImage"
corrigido="src-tauri/target/release/bundle/appimage/Koda_${versao}_amd64.wayland.tmp.AppImage"

rm -f -- "$corrigido"
trap 'rm -f -- "$corrigido"' EXIT
scripts/corrigir-appimage-wayland.sh "$appimage" "$corrigido"
mv -f -- "$corrigido" "$appimage"
trap - EXIT

echo "AppImage Linux final: $appimage"
