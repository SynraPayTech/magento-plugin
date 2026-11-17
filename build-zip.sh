#!/usr/bin/env sh
# Builds dist/synra-pay-magento2.zip with the module's own files at the zip
# root (composer.json, registration.php, etc/, Model/, view/, ...), the layout
# Magento module zips are published in. The merchant extracts it into
# app/code/Synra/Pay. Forward-slash entries (PowerShell's Compress-Archive
# writes backslashes, which break the module on Linux hosts).
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/synra-pay-magento2.zip
cd synra-pay
if command -v zip >/dev/null 2>&1; then
  zip -qr ../dist/synra-pay-magento2.zip . -x '*.DS_Store'
else
  /c/Windows/System32/tar.exe -a -cf ../dist/synra-pay-magento2.zip *
fi
cd ..
ls -la dist/synra-pay-magento2.zip
