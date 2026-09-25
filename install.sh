#!/usr/bin/env bash
# ==============================================================================
# Gentle-Playbook: Automated Installer
# Supports one-liner curl execution:
#   curl -fsSL https://raw.githubusercontent.com/DarkKevo/Gentle-Playbook/master/install.sh | bash
# Or local execution:
#   ./install.sh
# ==============================================================================

set -euo pipefail

REPO_URL="https://github.com/DarkKevo/Gentle-Playbook.git"
DEFAULT_INSTALL_DIR="${HOME}/.local/share/gentle-playbook"
BIN_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.config/gentle-playbook/languages"

echo "=========================================="
echo "  Installing Gentle-Playbook"
echo "=========================================="

# 1. Check prerequisites
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required but not installed." >&2
  exit 1
fi

# 2. Determine source directory (local clone vs remote curl)
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/package.json" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "📁 Using local repository at: ${SRC_DIR}"
else
  SRC_DIR="${DEFAULT_INSTALL_DIR}"
  echo "📥 Fetching Gentle-Playbook into ${SRC_DIR}..."
  if [ -d "${SRC_DIR}/.git" ]; then
    echo "↻ Updating existing installation..."
    git -C "${SRC_DIR}" pull --quiet
  else
    mkdir -p "$(dirname "${SRC_DIR}")"
    git clone --depth 1 "${REPO_URL}" "${SRC_DIR}"
  fi
fi

# 3. Install dependencies & build
echo "📦 Installing npm dependencies..."
cd "${SRC_DIR}"
npm install --silent

echo "🔨 Building TypeScript artifacts..."
npm run build --silent

# 4. Setup CLI in ~/.local/bin
mkdir -p "${BIN_DIR}"
mkdir -p "${CONFIG_DIR}"

CLI_BIN="${BIN_DIR}/gentle-playbook"
chmod +x "${SRC_DIR}/dist/cli.js"
ln -sf "${SRC_DIR}/dist/cli.js" "${CLI_BIN}"
echo "✓ Linked CLI binary to ${CLI_BIN}"

# 5. Register in Pi if pi is available
if command -v pi >/dev/null 2>&1; then
  echo "🔌 Registering package in Pi..."
  # Clean up duplicate registrations from alternate locations to prevent skill collision
  node -e '
    const fs = require("fs");
    const p = `${process.env.HOME}/.pi/agent/settings.json`;
    if (!fs.existsSync(p)) process.exit(0);
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(s.packages)) {
        s.packages = s.packages.filter(pkg => {
          const str = typeof pkg === "string" ? pkg : pkg.source;
          return !str.toLowerCase().includes("gentle-playbook");
        });
        fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");
      }
    } catch {}
  ' 2>/dev/null || true

  pi install "${SRC_DIR}"
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
