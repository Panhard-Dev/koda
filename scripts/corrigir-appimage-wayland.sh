#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Uso: $0 AppImage-original AppImage-corrigido" >&2
  exit 1
fi
original=$(realpath "$1")
destino=$(realpath -m "$2")
if [[ ! -f "$original" || -e "$destino" ]]; then
  echo 'Arquivo original inexistente ou destino já existe.' >&2
  exit 1
fi
for ferramenta in unsquashfs mksquashfs; do
  command -v "$ferramenta" >/dev/null || { echo "Instale $ferramenta (squashfs-tools)." >&2; exit 1; }
done

temporario=$(mktemp -d)
trap 'rm -rf -- "$temporario"' EXIT
cp -- "$original" "$temporario/original.AppImage"
chmod u+x "$temporario/original.AppImage"
offset=$("$temporario/original.AppImage" --appimage-offset)
[[ "$offset" =~ ^[0-9]+$ && "$offset" -gt 0 ]] || { echo 'AppImage inválido.' >&2; exit 1; }
unsquashfs -no-progress -o "$offset" -d "$temporario/AppDir" "$original" >/dev/null
biblioteca="$temporario/AppDir/usr/lib/libwayland-client.so.0"
[[ -f "$biblioteca" ]] || { echo 'Biblioteca Wayland não encontrada no pacote.' >&2; exit 1; }
rm -- "$biblioteca"
# O runtime original fica antes do sistema de arquivos SquashFS.
dd if="$original" of="$temporario/resultado.AppImage" bs=1 count="$offset" status=none
mksquashfs "$temporario/AppDir" "$temporario/sistema.squashfs" -noappend -all-root -comp zstd -processors 4 -no-progress >/dev/null
cat "$temporario/sistema.squashfs" >> "$temporario/resultado.AppImage"
chmod 755 "$temporario/resultado.AppImage"
# Verifica o pacote antes de disponibilizá-lo, inclusive recursos do celular.
lista=$(unsquashfs -ll -o "$offset" "$temporario/resultado.AppImage")
if grep -q 'usr/lib/libwayland-client.so' <<< "$lista"; then
  echo 'Biblioteca Wayland ainda presente no pacote.' >&2; exit 1
fi
for recurso in 'usr/lib/Koda/bin/cloudflared' 'usr/lib/Koda/link/server.py' 'usr/lib/Koda/mobile/index.html'; do
  grep -Fq "$recurso" <<< "$lista" || { echo "Recurso ausente: $recurso" >&2; exit 1; }
done
# Testa o próprio runtime do AppImage, incluindo suporte à compressão.
mkdir "$temporario/teste-extracao"
(cd "$temporario/teste-extracao" && "$temporario/resultado.AppImage" --appimage-extract >/dev/null)
for recurso in 'usr/lib/Koda/bin/cloudflared' 'usr/lib/Koda/link/server.py' 'usr/lib/Koda/mobile/index.html'; do
  cmp "$temporario/AppDir/$recurso" "$temporario/teste-extracao/squashfs-root/$recurso"
done
cp -- "$temporario/resultado.AppImage" "$destino"
chmod 755 "$destino"
echo "AppImage corrigido: $destino"
