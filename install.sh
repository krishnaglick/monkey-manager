#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${MONKEY_MANAGER_INSTALL_DIR:-$HOME/.local/share/monkey-manager}"
SETTINGS="$HOME/.claude/settings.json"

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull
else
  echo "Installing to $INSTALL_DIR..."
  git clone https://github.com/krishnaglick/monkey-manager "$INSTALL_DIR"
fi

# Build (prepare script runs tsc automatically)
npm install --prefix "$INSTALL_DIR"

# Merge into ~/.claude/settings.json
node - "$INSTALL_DIR" "$SETTINGS" <<'EOF'
const fs = require('fs');
const path = require('path');

const [installDir, settingsPath] = process.argv.slice(2);

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
}

settings.extraKnownMarketplaces ??= {};
settings.extraKnownMarketplaces['monkey-manager'] = {
  source: { source: 'local', path: installDir }
};

settings.enabledPlugins ??= {};
settings.enabledPlugins['monkey-manager@monkey-manager'] = 'user';

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Registered in', settingsPath);
EOF

echo ""
echo "Done. Start a new Claude Code session (or /reload-plugins) to activate."
echo "Verify: /mcp → monkey-manager → check, claim, release, active, whoami"
