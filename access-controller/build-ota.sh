#!/usr/bin/env bash
# Build a firmware image suitable for upload via POST /ota. Network and
# Conway settings are baked in at build time from network.env.
#
# Produces ./firmware.bin in the current directory. Upload with:
#
#   curl --data-binary @firmware.bin \
#     -H 'Content-Type: application/octet-stream' \
#     http://<device-ip>/ota
set -euo pipefail

cd "$(dirname "$0")"

ELF="target/xtensa-esp32-none-elf/release/access-controller"
OUT="firmware.bin"

echo "==> cargo build --release"
cargo build --release

echo "==> espflash save-image -> ${OUT}"
# save-image produces just the application image (no bootloader, no
# partition table) - exactly what gets written into ota_0 / ota_1, and
# exactly what POST /ota expects.
espflash save-image \
    --chip esp32 \
    "${ELF}" \
    "${OUT}"

SIZE=$(wc -c < "${OUT}" | tr -d " ")
echo "==> ${OUT}: ${SIZE} bytes"
echo
echo "Upload with:"
echo "  curl --data-binary @${OUT} \\"
echo "       -H 'Content-Type: application/octet-stream' \\"
echo "       http://<device-ip>/ota"
