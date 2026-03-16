#!/bin/bash
set -e

echo "========================================"
echo "  Dyad with OpenCode - One-Click Setup"
echo "========================================"

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
    echo ""
    echo "ERROR: Node.js 20+ is required. You have: $(node -v 2>/dev/null || echo 'not installed')"
    echo ""
    echo "Install Node.js 20 with:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    echo ""
    echo "Or use nvm:"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "  source ~/.bashrc"
    echo "  nvm install 20"
    echo ""
    exit 1
fi
echo "[OK] Node.js version: $(node -v)"

# Install dependencies
echo ""
echo "[1/4] Installing dependencies..."
npm install

# Rebuild native modules (Linux fix)
echo ""
echo "[2/4] Rebuilding native modules..."
npm rebuild better-sqlite3

# Setup database
echo ""
echo "[3/4] Setting up database..."
mkdir -p userData
npm run db:push

# Fix Electron sandbox for Linux
echo ""
echo "[4/4] Configuring Electron sandbox for Linux..."
SANDBOX_PATH="node_modules/electron/dist/chrome-sandbox"
if [ -f "$SANDBOX_PATH" ]; then
    echo "Fixing chrome-sandbox permissions (requires sudo)..."
    sudo chown root:root "$SANDBOX_PATH"
    sudo chmod 4755 "$SANDBOX_PATH"
    echo "[OK] Sandbox configured"
else
    echo "[SKIP] Sandbox file not found (may not be needed on your system)"
fi

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "Run the app with:"
echo "  npm start"
echo ""
