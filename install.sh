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

# 4. Setup storage directories & clean legacy CLI links
mkdir -p "${CONFIG_DIR}"
rm -f "${BIN_DIR}/gentle-playbook"

# 5. Register in Pi if pi is available
if command -v pi >/dev/null 2>&1; then
  echo "🔌 Registering package in Pi..."
  # Clean up duplicate registrations from alternate locations to prevent skill collision
  echo "  (Checking ~/.pi/agent/settings.json to prevent duplicate registrations)"
  SRC_DIR="${SRC_DIR}" DEFAULT_INSTALL_DIR="${DEFAULT_INSTALL_DIR}" REPO_URL="${REPO_URL}" node -e '
    const fs = require("fs");
    const path = require("path");
    const p = `${process.env.HOME}/.pi/agent/settings.json`;
    if (!fs.existsSync(p)) process.exit(0);

    function isGentlePlaybook(pkg) {
      if (pkg && typeof pkg === "object" && pkg.name === "gentle-playbook") return true;

      let str = null;
      if (typeof pkg === "string") {
        str = pkg;
      } else if (pkg && typeof pkg === "object" && typeof pkg.source === "string") {
        str = pkg.source;
      }
      if (!str) return false;

      const clean = s => s.replace(/\/+$/, "").replace(/\.git$/, "");
      const targetClean = clean(str);

      const repoClean = clean(process.env.REPO_URL || "https://github.com/DarkKevo/Gentle-Playbook");
      if (
        targetClean.toLowerCase() === repoClean.toLowerCase() ||
        targetClean.toLowerCase().endsWith("github.com/darkkevo/gentle-playbook")
      ) {
        return true;
      }

      const knownDirs = [
        process.env.SRC_DIR,
        process.env.DEFAULT_INSTALL_DIR,
        `${process.env.HOME}/.local/share/gentle-playbook`
      ].filter(Boolean).map(clean);

      if (knownDirs.includes(targetClean)) return true;

      try {
        if (fs.existsSync(str)) {
          const pkgJsonPath = path.join(str, "package.json");
          if (fs.existsSync(pkgJsonPath)) {
            const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
            if (pkgData && pkgData.name === "gentle-playbook") return true;
          }
        }
      } catch {}

      return false;
    }

    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(s.packages)) {
        const removed = [];
        const kept = [];
        for (const pkg of s.packages) {
          if (isGentlePlaybook(pkg)) {
            const id = typeof pkg === "string" ? pkg : (pkg.source || pkg.name || JSON.stringify(pkg));
            removed.push(id);
          } else {
            kept.push(pkg);
          }
        }
        if (removed.length > 0) {
          for (const rem of removed) {
            console.log(`  - Removing duplicate registration: ${rem}`);
          }
          s.packages = kept;
          fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");
          console.log(`  ✓ Cleaned up ${removed.length} previous gentle-playbook package entry/entries in settings.json`);
        }
      }
    } catch (err) {
      console.warn("  ⚠ Warning reading ~/.pi/agent/settings.json:", err.message);
    }
  ' || true

  pi install "${SRC_DIR}"
  echo "✓ Registered Gentle-Playbook package in Pi"
else
  echo "ℹ Pi command not found in PATH; skipping 'pi install'."
fi

echo ""
echo "=========================================="
echo "  ✓ Installation complete!"
echo "=========================================="
echo "Inside Pi (TUI-First):"
echo "  /playbook                  (ver playbooks activos y estado)"
echo "  /playbook extract          (extracción agéntica asistida por IA)"
echo "  /gentle-playbook-add       (sintetizador interactivo de reglas con IA)"
echo "  /playbook delete           (gestión y eliminación interactiva de reglas o playbooks)"
echo "=========================================="
