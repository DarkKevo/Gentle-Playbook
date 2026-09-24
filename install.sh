#!/usr/bin/env bash
# ==============================================================================
# Gentle-Playbook: Automated Installer
# Installs CLI binary and registers the native Pi package.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.config/gentle-playbook/languages"

echo "=========================================="
echo "  Installing Gentle-Playbook"
echo "=========================================="

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

# 2. Install dependencies & build
echo "📦 Installing npm dependencies..."
cd "${SCRIPT_DIR}"
npm install

echo "🔨 Building TypeScript artifacts..."
npm run build

# 3. Setup CLI in ~/.local/bin
mkdir -p "${BIN_DIR}"
mkdir -p "${CONFIG_DIR}"

CLI_BIN="${BIN_DIR}/gentle-playbook"
chmod +x "${SCRIPT_DIR}/dist/cli.js"
ln -sf "${SCRIPT_DIR}/dist/cli.js" "${CLI_BIN}"
echo "✓ Symlinked CLI binary to ${CLI_BIN}"

# 4. Register in Pi if pi is available
if command -v pi >/dev/null 2>&1; then
  echo "🔌 Registering package in Pi..."
  pi install "${SCRIPT_DIR}"
  echo "✓ Registered Gentle-Playbook package in Pi"
else
  echo "ℹ Pi command not found in PATH; skipping 'pi install'."
fi

echo ""
echo "=========================================="
echo "  ✓ Installation complete!"
echo "=========================================="
echo "Available CLI commands:"
echo "  gentle-playbook list"
echo "  gentle-playbook show <lang>"
echo "  gentle-playbook extract <path-to-repo>"
echo ""
echo "Inside Pi:"
echo "  /gentle-playbook           (inspect active playbooks)"
echo "  /gentle-playbook-add       (interactive rule synthesizer)"
echo "=========================================="
