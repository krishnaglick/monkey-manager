#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${MONKEY_MANAGER_INSTALL_DIR:-$HOME/.local/share/monkey-manager}"
SETTINGS="$HOME/.claude/settings.json"

# Remove from settings.json
if [ -f "$SETTINGS" ]; then
  node - "$SETTINGS" <<'EOF'
const fs = require('fs');
const [settingsPath] = process.argv.slice(2);
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { process.exit(0); }
delete settings.extraKnownMarketplaces?.['monkey-manager'];
delete settings.enabledPlugins?.['monkey-manager@monkey-manager'];
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Removed from', settingsPath);
EOF
fi

# Remove install dir
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "Removed $INSTALL_DIR"
fi

echo ""
echo "Done. Start a new Claude Code session (or /reload-plugins) to deactivate."
