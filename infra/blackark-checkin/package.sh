#!/usr/bin/env bash
# Zips the receiver for upload: the checkin/ folder, without config.php or any stored data.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/blackark-checkin-$(date +%Y%m%d).zip"
cd "$here"
rm -f "$out"
zip -qr "$out" checkin README.md -x 'checkin/config.php' 'checkin/data/*.sqlite*'
echo "$out"
sha256sum "$out"
