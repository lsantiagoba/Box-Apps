#!/bin/bash

# Uninstallation script for Box Apps
# Removes the extension and its settings. App Grid folders are never touched.
set -e

EXTENSION_UUID="box-apps@lsantiagoba"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "Disabling extension..."
if command -v gnome-extensions &> /dev/null; then
    gnome-extensions disable $EXTENSION_UUID 2>/dev/null || true
fi

echo "Removing extension files..."
rm -rf "$EXTENSION_DIR"

echo "Removing saved settings..."
dconf reset -f /org/gnome/shell/extensions/box-apps/ 2>/dev/null || true

echo "Done. Restart GNOME Shell to finish the removal."
exit 0
