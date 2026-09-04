#!/usr/bin/env bash
# Install the extension into VS Code by copying it where VS Code looks for
# extensions. Deliberately not vsce: this needs no downloads and no packaging step,
# which matters on a slow connection. Reload the VS Code window afterwards.
#
#   ./vscode-extension/install.sh          # install / update
#   ./vscode-extension/install.sh --remove # uninstall
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(node -p "require('$here/package.json').version")"
target="$HOME/.vscode/extensions/local.live-md-vscode-$version"

if [ "${1:-}" = "--remove" ]; then
  rm -rf "$target"
  echo "removed $target — reload the VS Code window"
  exit 0
fi

(cd "$here/.." && npm run --silent build:extension)
rm -rf "$target"
mkdir -p "$target"
cp "$here/package.json" "$target/"
cp -r "$here/dist" "$target/"
echo "installed to $target"
echo "reload the VS Code window (Developer: Reload Window), then run 'live-md: Open'"
